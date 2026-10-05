import {
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Param,
  Query,
  Body,
  Res,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { compare } from 'bcryptjs';
import { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database';
import { AuthService, UserRequest } from '../auth';
import { AgentOAuth, urls, scopeInput, oauthDays } from './oauth';
import { AgentOperations } from './operations';
import { protocolTools, tokenDays } from './information';
@Controller('api/agent')
export class AgentManagementController {
  constructor(
    private db: Database,
    private oauth: AgentOAuth,
    private operations: AgentOperations,
    private auth: AuthService,
  ) {}
  @Get() async list(@Req() r: UserRequest) {
    const grants = await this.db.agentGrant.findMany({
      where: { userId: r.userId },
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
        refreshExpiresAt: true,
        createdAt: true,
        revokedAt: true,
        clientId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const operations = await this.db.agentOperation.findMany({
      where: { userId: r.userId },
      select: {
        id: true,
        tool: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const calls = await this.db.agentCall.findMany({
      where: { userId: r.userId },
      select: { id: true, tool: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      mcpUrl: urls().resource.toString(),
      capabilities: [
        ...this.operations.tools.map((t) => ({
          name: t.name,
          description: t.description,
          scope: t.scope,
          destructive: !!t.destructive,
        })),
        ...protocolTools,
      ],
      grants,
      operations,
      calls,
    };
  }
  @Post('tokens') async token(@Req() r: UserRequest, @Body() raw: unknown) {
    const p = z
      .object({
        name: z.string().trim().min(1).max(100),
        scopes: scopeInput,
        days: z.union([z.literal(null), ...tokenDays.map((d) => z.literal(d))]),
        password: z.string().max(72),
      })
      .strict()
      .parse(raw);
    this.auth.limit(r);
    const u = await this.db.user.findUniqueOrThrow({ where: { id: r.userId } });
    if (!(await compare(p.password, u.passwordHash))) throw new ForbiddenException('密码错误');
    return this.db.atomic(async () => {
      const v = await this.oauth.issue(r.userId, p.name, p.scopes, p.days);
      return { id: v.grant.id, token: v.tokens.access_token, expiresAt: v.grant.expiresAt };
    });
  }
  @Delete('connections/:id') async revoke(@Req() r: UserRequest, @Param('id') id: string) {
    z.string().uuid().parse(id);
    await this.db.agentGrant.updateMany({
      where: { id, userId: r.userId },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }
  @Get('authorizations/:id') pending(@Param('id') id: string) {
    return this.oauth.pending(z.string().uuid().parse(id));
  }
  @Post('authorizations/:id') async consent(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const { approve, scopes, days } = z
      .object({ approve: z.boolean(), scopes: scopeInput.optional(), days: oauthDays.default(30) })
      .strict()
      .parse(raw);
    return this.oauth.consent(r.userId, z.string().uuid().parse(id), approve, scopes, days);
  }

  @Get('drafts') drafts(@Req() r: UserRequest, @Query('cursor') cursor?: string) {
    return this.operations.drafts(r.userId, cursor ? z.string().uuid().parse(cursor) : undefined);
  }
  @Post('operations/confirm-batch') async confirmBatch(
    @Req() r: UserRequest,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.limit(r);
    return this.operations.confirmBatch(r, raw, res);
  }
  @Get('operations/:id') preview(@Req() r: UserRequest, @Param('id') id: string) {
    return this.operations.preview(r.userId, z.string().uuid().parse(id));
  }
  @Post('operations/:id') async confirm(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.limit(r);
    z.string().uuid().parse(id);
    try {
      return await this.operations.confirm(r, id, raw, res);
    } catch (e) {
      const row = await this.db.agentOperation.findFirst({
        where: { id, userId: r.userId, status: 'pending' },
      });
      if (row) {
        await this.db.agentOperation.updateMany({
          where: { id, userId: r.userId, status: 'pending' },
          data: {
            result: {
              status: 'submission_failed',
              message:
                e instanceof HttpException ? e.message : '提交失败，账目已回滚；可重试或取消',
            },
          },
        });
        await this.db.agentCall.create({
          data: { userId: r.userId, grantId: row.grantId, tool: row.tool, status: 'error' },
        });
      }
      throw e;
    }
  }
}
