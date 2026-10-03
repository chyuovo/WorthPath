import {
  Injectable,
  OnModuleDestroy,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  HttpException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, Express } from 'express';
import multer, { memoryStorage } from 'multer';
import { AgentOAuth, urls } from './oauth';
import { UserRequest } from '../auth';
import { IconsBusinessService } from '../icons';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

type Ticket = {
  userId: string;
  grantId: string;
  expires: number;
  kind: 'icon' | 'image';
  iconId?: string;
  buffer?: Buffer;
  name?: string;
};
@Injectable()
export class AgentFiles implements OnModuleDestroy {
  private tickets = new Map<string, Ticket>();
  private timer = setInterval(() => {
    for (const [id, t] of this.tickets) if (t.expires < Date.now()) this.tickets.delete(id);
  }, 60000).unref();
  constructor(
    private oauth: AgentOAuth,
    private icons: IconsBusinessService,
  ) {}
  onModuleDestroy() {
    clearInterval(this.timer);
    this.tickets.clear();
  }
  async issue(r: UserRequest, grantId: string, kind: Ticket['kind'], iconId?: string) {
    if (
      this.tickets.size >= 1000 ||
      [...this.tickets.values()].filter((t) => t.userId === r.userId).length >= 20
    )
      throw new BadRequestException('文件请求过多，请等待过期');
    const id = randomUUID();
    this.tickets.set(id, {
      userId: r.userId,
      grantId,
      kind,
      iconId,
      expires: Date.now() + 600000,
    });
    return {
      fileId: id,
      url: new URL('/api/agent/files/' + id, urls().issuer).toString(),
      method: kind === 'image' ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer <your access token>' },
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maxBytes: 2 * 1024 * 1024,
      format: kind === 'image' ? 'image/png' : 'multipart/form-data; field file; image',
    };
  }
  private ticket(r: UserRequest, grantId: string, id: string) {
    const t = this.tickets.get(id);
    if (!t || t.userId !== r.userId || t.grantId !== grantId || t.expires < Date.now())
      throw new ForbiddenException('文件入口已失效或不属于此连接');
    return t;
  }
  async publishIcon(r: UserRequest, grantId: string, id: string, name: string, shared: boolean) {
    const t = this.ticket(r, grantId, id);
    if (t.kind !== 'icon' || !t.buffer) throw new BadRequestException('请先上传图标');
    return this.icons.upload(
      r,
      { name, shared: String(shared), ...(shared ? { confirmed: 'true' } : {}) },
      { buffer: t.buffer } as Express.Multer.File,
    );
  }
  async inspect(r: UserRequest, grantId: string, id: string) {
    const t = this.ticket(r, grantId, id);
    return {
      fileId: id,
      uploaded: !!t.buffer,
      expiresAt: new Date(t.expires).toISOString(),
    };
  }
  async context(req: Request) {
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '');
    if (!match) throw new UnauthorizedException('Bearer token required');
    const auth = await this.oauth.verifyAccessToken(match[1]),
      grant = await this.oauth.grant(String(auth.extra.grantId));
    return {
      grant,
      r: {
        ...req,
        userId: grant.userId,
        sessionId: grant.sessionId,
        revealed: false,
        agent: true,
      } as UserRequest,
    };
  }
  install(app: Express) {
    const memory = multer({
      storage: memoryStorage(),
      limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
    }).single('file');
    app.all('/api/agent/files/:id', async (req, res) => {
      try {
        const { grant, r } = await this.context(req);
        const t = this.ticket(r, grant.id, String(req.params.id));
        if (!['GET', 'POST'].includes(req.method)) {
          res.status(405).end();
          return;
        }
        if ((req.method === 'POST') !== (t.kind === 'icon')) {
          res.status(405).end();
          return;
        }
        if (req.method === 'GET') {
          await this.icons.image(r, t.iconId!, res);
          return;
        }
        const selected = grant.scopes as string[];
        if (!selected.includes('draft') && !selected.includes('write'))
          throw new ForbiddenException('上传需要 draft 或 write 权限');
        await new Promise<void>((resolve, reject) =>
          memory(req, res, (e) => (e ? reject(e) : resolve())),
        );
        if (!req.file) throw new BadRequestException('请选择文件');
        t.buffer = req.file.buffer;
        res.json(await this.inspect(r, grant.id, String(req.params.id)));
      } catch (e) {
        if (!res.headersSent)
          res
            .status(
              e instanceof HttpException
                ? e.getStatus()
                : e instanceof InvalidTokenError
                  ? 401
                  : 400,
            )
            .json({ message: e instanceof HttpException ? e.message : '文件操作失败或认证已失效' });
      }
    });
  }
}
