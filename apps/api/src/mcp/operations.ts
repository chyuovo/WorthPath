import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, AgentGrant } from '@prisma/client';
import { compare } from 'bcryptjs';
import { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database';
import { AuthBusinessService, UserRequest } from '../auth';
import { BackupBusinessService } from '../backup';
import { AgentOAuth, digest, webLink } from './oauth';
import { AgentCatalogue, ToolDefinition, empty } from './catalogue';
import { AgentFiles } from './files';
export const writing = {
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .describe('同用户唯一幂等键；重试使用相同键和全部参数，改动参数必须换键'),
  expectedState: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('先 state_get 获取 state，避免覆盖并发修改；状态变化后重新读取并使用新幂等键'),
};
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
function stable(v: any): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}
@Injectable()
export class AgentOperations {
  readonly tools: ToolDefinition[];
  constructor(
    private db: Database,
    private oauth: AgentOAuth,
    catalogue: AgentCatalogue,
    private auth: AuthBusinessService,
    private backup: BackupBusinessService,
    private files: AgentFiles,
  ) {
    this.tools = [
      ...catalogue.tools,
      {
        name: 'backup_export',
        description:
          '创建短期受 Bearer 保护的完整 ZIP 备份下载入口，包含隐藏项目；网页验证密码并确认后 operation_get 获取入口，URL 本身不是凭证。',
        schema: empty,
        scope: 'sensitive',
        run: async (r) => this.files.issue(r, r.agentGrantId!, 'download'),
      },
      {
        name: 'icon_publish',
        description:
          '保存已上传图标，shared=true 发布到共享库，须中文名称及网页确认。先 file_upload_request(kind=icon)。',
        schema: z
          .object({
            fileId: z.string().uuid(),
            name: z.string().min(1).max(100),
            shared: z.boolean().default(false),
          })
          .strict(),
        scope: 'write',
        run: (r, p) => this.files.publishIcon(r, r.agentGrantId!, p.fileId, p.name, p.shared),
      },
      {
        name: 'hidden_lock',
        description: '立即锁定本连接的隐藏项目授权。',
        schema: empty,
        scope: 'write',
        run: async (r) => this.auth.lock(r),
      },
    ];
  }
  get(name: string) {
    const t = this.tools.find((t) => t.name === name);
    if (!t) throw new BadRequestException('未知工具');
    return t;
  }
  async context(grant: AgentGrant) {
    const s = await this.db.session.findUnique({ where: { id: grant.sessionId } });
    if (!s || s.expiresAt <= new Date()) throw new ForbiddenException('连接会话失效，请重新授权');
    return {
      userId: grant.userId,
      sessionId: grant.sessionId,
      revealed: !!s.revealUntil && +s.revealUntil > Date.now(),
      agent: true,
      agentGrantId: grant.id,
      cookies: {},
    } as UserRequest;
  }
  async state(userId: string) {
    const data = await Promise.all([
      this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          username: true,
          baseCurrency: true,
          hiddenMenus: true,
          showNotes: true,
          idleMinutes: true,
          accountGroupOrder: true,
          sessionHours: true,
          requireHiddenPassword: true,
          overviewCards: true,
          includeIndependentAssets: true,
        },
      }),
      this.db.position.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        include: { revisions: { orderBy: { id: 'asc' } }, outgoing: { orderBy: { id: 'asc' } } },
      }),
      this.db.transfer.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.schedule.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.exchangeRate.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.metalPrice.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.icon.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, hash: true, shared: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return digest(stable(plain(data)));
  }
  private sensitive(t: ToolDefinition, p: any) {
    return (
      t.scope === 'sensitive' ||
      (t.name === 'settings_update' && p.requireHiddenPassword !== undefined) ||
      (t.name === 'icon_publish' && p.shared)
    );
  }
  private async permission(grant: AgentGrant, t: ToolDefinition, p: any) {
    const selected = grant.scopes as string[],
      mode =
        (await this.db.agentPolicy.findUnique({ where: { userId: grant.userId } }))?.mode ||
        'draft';
    if (!selected.includes('read')) throw new ForbiddenException('缺少 read 权限');
    if (t.scope === 'read') return { mode, sensitive: false };
    const sensitive = this.sensitive(t, p);
    if (sensitive && !selected.includes('sensitive'))
      throw new ForbiddenException('此操作需要 sensitive 权限');
    if (!sensitive && !selected.includes('write') && !selected.includes('draft'))
      throw new ForbiddenException('缺少 draft 或 write 权限');
    if (mode === 'readonly' && !['backup_export', 'hidden_unlock_request'].includes(t.name))
      throw new ForbiddenException('当前用户写入策略为只读');
    return { mode, sensitive };
  }
  async call(grantId: string, name: string, input: any) {
    const t = this.get(name);
    const parsed = (t.scope === 'read' ? t.schema : t.schema.safeExtend(writing)).parse(input);
    const { idempotencyKey, expectedState, ...p } = parsed as any;
    const grant = await this.oauth.grant(grantId),
      permission = await this.permission(grant, t, p);
    if (t.scope === 'read') return t.run!(await this.context(grant), p);
    const hash = digest(stable({ tool: name, parameters: p, expectedState }));
    return this.db.atomic(async () => {
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${grant.userId} FOR UPDATE`);
      const fresh = await this.oauth.grant(grantId),
        access = await this.permission(fresh, t, p);
      const existing = await this.db.agentOperation.findUnique({
        where: { userId_key: { userId: grant.userId, key: idempotencyKey } },
      });
      if (existing) {
        if (existing.hash !== hash || existing.grantId !== grant.id)
          throw new ConflictException('幂等键已用于不同参数或连接');
        return this.view(existing);
      }
      const snapshot = await this.state(grant.userId);
      if (snapshot !== expectedState)
        throw new ConflictException('账目已变化，请重新读取 state_get 和数据后使用新幂等键');
      const row = await this.db.agentOperation.create({
        data: {
          userId: grant.userId,
          grantId,
          key: idempotencyKey,
          hash,
          tool: name,
          parameters: plain(p),
          snapshot,
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      if (
        access.sensitive ||
        access.mode === 'draft' ||
        !(fresh.scopes as string[]).includes('write')
      )
        return this.view(row);
      const result = await this.execute(t, fresh, p);
      return this.view(
        await this.db.agentOperation.update({
          where: { id: row.id },
          data: { status: 'completed', result: plain(result), completedAt: new Date() },
        }),
      );
    });
  }
  private async execute(t: ToolDefinition, grant: AgentGrant, p: any) {
    return t.run!(await this.context(grant), p);
  }
  private view(row: any) {
    return {
      operationId: row.id,
      tool: row.tool,
      status: row.status === 'pending' && row.expiresAt < new Date() ? 'expired' : row.status,
      expiresAt: row.expiresAt,
      result: row.result,
      confirmationUrl: row.status === 'pending' ? webLink('agent_operation', row.id) : undefined,
    };
  }
  async status(grantId: string, id: string) {
    const grant = await this.oauth.grant(grantId),
      row = await this.db.agentOperation.findFirst({
        where: { id, userId: grant.userId, grantId },
      });
    if (!row) throw new NotFoundException('操作不存在');
    return this.view(row);
  }
  async preview(userId: string, id: string) {
    const row = await this.db.agentOperation.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('操作不存在');
    const t = this.get(row.tool),
      grant = await this.oauth.grant(row.grantId, userId);
    let impact: unknown = { parameters: row.parameters, message: t.description };
    if (t.name === 'backup_import')
      impact = (
        await this.backup.inspectUpload(await this.context(grant), (row.parameters as any).token)
      ).preview;
    if (t.web === 'clear')
      impact = {
        positions: await this.db.position.count({ where: { userId } }),
        history: await this.db.revision.count({ where: { position: { userId } } }),
        schedules: await this.db.schedule.count({ where: { userId } }),
        message: '清空账户、资产、债务、历史、私有图标和汇率；保留账号和个人设置。先下载当前备份。',
      };
    return {
      ...this.view(row),
      impact,
      web: t.web,
      sensitive: this.sensitive(t, row.parameters),
      description: t.description,
    };
  }
  async confirm(r: UserRequest, id: string, raw: unknown, res: Response) {
    const input = z
      .object({
        approve: z.boolean(),
        password: z.string().max(72).optional(),
        username: z.string().max(64).optional(),
        newPassword: z.string().max(72).optional(),
        confirmation: z.string().max(20).optional(),
      })
      .strict()
      .parse(raw);
    return this.db.atomic(async () => {
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${r.userId} FOR UPDATE`);
      const row = await this.db.agentOperation.findFirst({ where: { id, userId: r.userId } });
      if (!row) throw new NotFoundException('操作不存在');
      if (row.status !== 'pending' || row.expiresAt <= new Date())
        throw new ConflictException('操作已完成或失效');
      if (!input.approve)
        return this.view(
          await this.db.agentOperation.update({
            where: { id },
            data: { status: 'cancelled', completedAt: new Date() },
          }),
        );
      const grant = await this.oauth.grant(row.grantId, r.userId),
        t = this.get(row.tool),
        p = row.parameters as any;
      const access = await this.permission(grant, t, p);
      if (access.sensitive) {
        const u = await this.db.user.findUniqueOrThrow({ where: { id: r.userId } });
        if (!input.password || !(await compare(input.password, u.passwordHash)))
          throw new ForbiddenException('请验证当前密码');
      }
      if ((await this.state(r.userId)) !== row.snapshot)
        throw new ConflictException('账目已变化，请取消并重新创建操作');
      let result: unknown;
      if (t.web === 'credentials') {
        result = await this.auth.changeCredentials(
          r,
          {
            currentPassword: input.password,
            username: input.username,
            newPassword: input.newPassword,
          },
          res,
        );
        await this.db.agentGrant.updateMany({
          where: { userId: r.userId, id: { not: grant.id } },
          data: { revokedAt: new Date() },
        });
        await this.db.session.create({
          data: { id: grant.sessionId, userId: r.userId, expiresAt: new Date(Date.now() + 300000) },
        });
        await this.db.agentGrant.update({
          where: { id: grant.id },
          data: { scopes: ['read'], expiresAt: new Date(Date.now() + 300000), refreshDigest: null },
        });
      } else if (t.web === 'reveal')
        result = await this.auth.reveal(
          Object.assign(Object.create(r), { sessionId: grant.sessionId }),
          { password: input.password },
        );
      else if (t.web === 'clear')
        result = await this.backup.clear(r, { confirmation: input.confirmation });
      else result = await this.execute(t, grant, p);
      return this.view(
        await this.db.agentOperation.update({
          where: { id },
          data: { status: 'completed', result: plain(result), completedAt: new Date() },
        }),
      );
    }, 300000);
  }
  async uploadRequest(grantId: string, kind: 'backup' | 'icon') {
    const grant = await this.oauth.grant(grantId);
    const selected = grant.scopes as string[];
    if (!selected.includes('draft') && !selected.includes('write'))
      throw new ForbiddenException('上传需要 draft 或 write 权限');
    if (
      (await this.db.agentPolicy.findUnique({ where: { userId: grant.userId } }))?.mode ===
      'readonly'
    )
      throw new ForbiddenException('当前策略为只读');
    return this.files.issue(await this.context(grant), grantId, kind);
  }
  async fileStatus(grantId: string, id: string) {
    const g = await this.oauth.grant(grantId);
    return this.files.inspect(await this.context(g), grantId, id);
  }
  async iconImage(grantId: string, id: string) {
    const g = await this.oauth.grant(grantId);
    return this.files.issue(await this.context(g), grantId, 'image', id);
  }
}
