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
import multer, { diskStorage, memoryStorage } from 'multer';
import { tmpdir } from 'node:os';
import { unlink } from 'node:fs/promises';
import { AgentOAuth, urls } from './oauth';
import { UserRequest } from '../auth';
import { BackupBusinessService } from '../backup';
import { IconsBusinessService } from '../icons';
import { MAX_UPLOAD_BYTES } from '../zip';
import { Database } from '../database';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

type Ticket = {
  userId: string;
  grantId: string;
  expires: number;
  kind: 'backup' | 'icon' | 'download' | 'image';
  snapshot?: string;
  iconId?: string;
  buffer?: Buffer;
  name?: string;
  preview?: unknown;
  token?: string;
};
@Injectable()
export class AgentFiles implements OnModuleDestroy {
  private tickets = new Map<string, Ticket>();
  private timer = setInterval(() => {
    for (const [id, t] of this.tickets) if (t.expires < Date.now()) this.tickets.delete(id);
  }, 60000).unref();
  constructor(
    private oauth: AgentOAuth,
    private backup: BackupBusinessService,
    private icons: IconsBusinessService,
    private db: Database,
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
      ...(kind === 'download' ? { snapshot: await this.backup.snapshot(r.userId) } : {}),
    });
    return {
      fileId: id,
      url: new URL('/api/agent/files/' + id, urls().issuer).toString(),
      method: kind === 'download' || kind === 'image' ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer <your access token>' },
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      maxBytes: kind === 'backup' ? MAX_UPLOAD_BYTES : 2 * 1024 * 1024,
      format:
        kind === 'backup'
          ? 'multipart/form-data; field file; WorthPath ZIP/JSON'
          : 'multipart/form-data; field file; image',
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
      uploaded: !!t.buffer || !!t.token,
      token: t.token,
      preview: t.preview,
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
    const disk = multer({
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_r, _f, cb) => cb(null, 'worthpath-import-' + randomUUID() + '.zip'),
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0 },
    }).single('file');
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
        if ((req.method === 'POST') !== (t.kind === 'backup' || t.kind === 'icon')) {
          res.status(405).end();
          return;
        }
        if (req.method === 'GET') {
          if (t.kind === 'download') await this.backup.download(r, res, t.snapshot);
          else await this.icons.image(r, t.iconId!, res);
          return;
        }
        const selected = grant.scopes as string[];
        if (!selected.includes('draft') && !selected.includes('write'))
          throw new ForbiddenException('上传需要 draft 或 write 权限');
        if (
          (await this.db.agentPolicy.findUnique({ where: { userId: grant.userId } }))?.mode ===
          'readonly'
        )
          throw new ForbiddenException('当前策略为只读');
        await new Promise<void>((resolve, reject) =>
          (t.kind === 'backup' ? disk : memory)(req, res, (e) => (e ? reject(e) : resolve())),
        );
        if (!req.file) throw new BadRequestException('请选择文件');
        try {
          if (t.kind === 'backup') {
            const v = await this.backup.upload(r, req.file);
            t.token = v.token;
            t.preview = v;
          } else t.buffer = req.file.buffer;
          res.json(await this.inspect(r, grant.id, String(req.params.id)));
        } catch (e) {
          if (req.file.path) await unlink(req.file.path).catch(() => {});
          throw e;
        }
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
