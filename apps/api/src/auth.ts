import { networkConfig, isNetworkOriginAllowed } from './network';
import {
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  BadRequestException,
  Body,
  Req,
  Res,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  SetMetadata,
  OnModuleInit,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { Database } from './database';
import { credentials, credentialChange, defaultOverviewCards } from './validation';
import { Prisma } from '@prisma/client';
import { loginInput } from './user-access';
export type UserRequest = Request & {
  userId: string;
  sessionId: string;
  revealed: boolean;
  agent?: boolean;
  agentGrantId?: string;
};
const Public = () => SetMetadata('public', true);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function allowedOrigin(
  origin: string | undefined,
  configured: string | undefined,
  production = false,
) {
  return isNetworkOriginAllowed(origin, configured, !production);
}
@Injectable()
export class AuthService implements OnModuleInit {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private db: Database) {}
  async onModuleInit() {
    // Never reset or promote an existing account based on environment defaults.
    const username = credentials.shape.username.parse(process.env.ADMIN_USERNAME ?? 'admin');
    const password = loginInput.shape.password.parse(process.env.ADMIN_PASSWORD ?? 'admin');
    if (await this.db.user.count({ where: { role: 'admin' } })) return;
    const passwordHash = await hash(password, 12);
    await this.db.serial(async (tx) => {
      if (await tx.user.count({ where: { role: 'admin' } })) return;
      if (await tx.user.findUnique({ where: { username } }))
        throw new Error(
          'Default administrator username already exists; configure a different ADMIN_USERNAME',
        );
      await tx.user.create({
        data: { username, passwordHash, role: 'admin', mustChangePassword: true },
      });
    });
  }
  limit(req: Request) {
    const network = networkConfig();
    if (!network.rateLimitEnabled) return;
    const key =
        (req.ip || 'local') +
        ('userId' in req && typeof req.userId === 'string' ? ':' + req.userId : ''),
      now = Date.now();
    let v = this.attempts.get(key);
    if (!v || v.until < now) {
      v = { count: 0, until: now + network.rateLimitWindowMs };
      this.attempts.set(key, v);
    }
    if (++v.count > network.authRateLimitMax)
      throw new HttpException('尝试过于频繁，请稍后重试', 429);
    if (this.attempts.size > 10000) {
      for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
      if (this.attempts.size > 10000) throw new HttpException('服务繁忙，请稍后重试', 429);
    }
  }
  async issue(userId: string, res: Response) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const token = randomBytes(32).toString('hex'),
      expiresAt = new Date(Date.now() + user.sessionHours * 3600000);
    await this.db.session.create({ data: { id: digest(token), userId, expiresAt } });
    this.cookie(token, expiresAt, res);
  }
  cookie(token: string, expiresAt: Date, res: Response) {
    res.cookie('wp_session', token, {
      httpOnly: true,
      sameSite: networkConfig().sameSite,
      secure: networkConfig().cookieSecure,
      expires: expiresAt,
      path: '/api',
    });
  }
  async user(token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = await this.db.session.findUnique({ where: { id: digest(token) } });
    if (!s || s.expiresAt <= new Date()) return null;
    const u = await this.db.user.findUniqueOrThrow({
      where: { id: s.userId },
      select: { idleMinutes: true, banned: true },
    });
    if (u.banned) throw new UnauthorizedException('账号已被封禁');
    if (u.idleMinutes && Date.now() - +s.lastActivity >= u.idleMinutes * 60000) {
      await this.db.session.deleteMany({ where: { id: s.id } });
      throw new UnauthorizedException('长时间无操作，已自动退出登录');
    }
    return s;
  }
  async logout(req: Request, res: Response) {
    if (typeof req.cookies?.wp_session === 'string')
      await this.db.session.deleteMany({ where: { id: digest(req.cookies.wp_session) } });
    res.clearCookie('wp_session', {
      path: '/api',
      sameSite: networkConfig().sameSite,
      secure: networkConfig().cookieSecure,
      httpOnly: true,
    });
  }
  async access(req: UserRequest) {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: req.userId } });
    if (u.banned) throw new UnauthorizedException('账号已被封禁');
    const path = req.path.replace(/\/$/, '');
    const passwordAllowed = [
      '/api/auth/me',
      '/api/auth/credentials',
      '/api/auth/logout',
      '/api/auth/activity',
    ];
    if (u.mustChangePassword && !passwordAllowed.includes(path))
      throw new ForbiddenException('首次登录必须修改密码');
    const connectionManagement =
      path === '/api/agent/tokens' ||
      /^\/api\/agent\/(authorizations|connections)\/[a-f0-9-]{36}$/.test(path);
    if (
      u.role === 'readonly' &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !path.startsWith('/api/auth/') &&
      !connectionManagement
    )
      throw new ForbiddenException('只读账号不能修改数据');
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private auth: AuthService,
    private reflector: Reflector,
  ) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<UserRequest>();
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !allowedOrigin(
        req.headers.origin,
        process.env.WEB_ORIGIN,
        !networkConfig().allowWildcardOrigins,
      )
    )
      throw new ForbiddenException('请求来源不受信任');
    if (this.reflector.get<boolean>('public', ctx.getHandler())) return true;
    const id = await this.auth.user(req.cookies?.wp_session);
    if (!id) throw new UnauthorizedException('请先登录');
    req.userId = id.userId;
    req.sessionId = id.id;
    req.revealed = !!id.revealUntil && +id.revealUntil > Date.now();
    await this.auth.access(req);
    return true;
  }
}

@Injectable()
export class AuthBusinessService {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}
  health() {
    return { status: 'ok' };
  }
  async register(body: unknown, req: Request, res: Response) {
    throw new ForbiddenException('公开注册已关闭，请联系管理员创建账号');
  }
  async login(body: unknown, req: Request, res: Response) {
    this.auth.limit(req);
    const v = loginInput.parse(body),
      user = await this.db.user.findUnique({ where: { username: v.username } });
    const ok = await compare(
      v.password,
      user?.passwordHash || '$2b$12$JZKvzAzfqM3obKxMQTFBjOzqIIKG97kn96/xUMbgTuWUnlMAT2bSi',
    );
    if (!user || !ok) throw new UnauthorizedException('账号或密码错误');
    if (user.banned) throw new ForbiddenException('账号已被封禁');
    await this.auth.issue(user.id, res);
    return {
      username: user.username,
      baseCurrency: user.baseCurrency,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      hiddenMenus: [],
    };
  }
  async me(req: UserRequest) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: {
        id: true,
        role: true,
        mustChangePassword: true,
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
    });
    const session = await this.db.session.findUniqueOrThrow({ where: { id: req.sessionId } });
    return {
      ...user,
      accountGroupOrder: user.accountGroupOrder || [],
      overviewCards: user.overviewCards ?? [...defaultOverviewCards],
      includeIndependentAssets: user.includeIndependentAssets,
      sessionExpiresAt: session.expiresAt,
      hiddenMenus: user.hiddenMenus.split(',').filter(Boolean),
      revealed: req.revealed,
      revealUntil: session.revealUntil,
      lastActivity: session.lastActivity,
    };
  }
  async changeCredentials(r: UserRequest, body: unknown, res: Response) {
    this.auth.limit(r);
    const v = credentialChange.parse(body);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: r.userId } });
    if (!(await compare(v.currentPassword, user.passwordHash)))
      throw new ForbiddenException('当前密码错误');
    if (
      user.mustChangePassword &&
      (!v.newPassword || (await compare(v.newPassword, user.passwordHash)))
    )
      throw new BadRequestException('请设置与初始密码不同的新密码（至少 10 个字符）');
    if ((!v.username || v.username === user.username) && !v.newPassword)
      throw new BadRequestException('请填写新的账号或密码');
    const passwordHash = v.newPassword ? await hash(v.newPassword, 12) : user.passwordHash;
    const token = randomBytes(32).toString('hex'),
      expiresAt = new Date(Date.now() + user.sessionHours * 3600000);
    await this.db.serial(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id = ${r.userId} FOR UPDATE`);
      const current = await tx.user.findUniqueOrThrow({ where: { id: r.userId } });
      if (
        current.banned ||
        current.passwordHash !== user.passwordHash ||
        current.username !== user.username
      )
        throw new ForbiddenException('账号已变更，请重新登录后操作');
      await tx.user.update({
        where: { id: r.userId },
        data: {
          username: v.username,
          passwordHash,
          ...(v.newPassword ? { mustChangePassword: false } : {}),
        },
      });
      await tx.agentGrant.updateMany({
        where: { userId: r.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { userId: r.userId } });
      await tx.session.create({ data: { id: digest(token), userId: r.userId, expiresAt } });
    });
    this.auth.cookie(token, expiresAt, res);
    return { ok: true };
  }
  async activity(r: UserRequest) {
    await this.db.session.update({
      where: { id: r.sessionId },
      data: { lastActivity: new Date() },
    });
    return { ok: true };
  }
  async reveal(r: UserRequest, b: unknown) {
    this.auth.limit(r);
    const revealUntil = await this.db.serial(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id = ${r.userId} FOR UPDATE`);
      const u = await tx.user.findUniqueOrThrow({ where: { id: r.userId } });
      if (u.requireHiddenPassword) {
        const { password } = credentials.pick({ password: true }).parse(b);
        if (!(await compare(password, u.passwordHash))) throw new ForbiddenException('密码错误');
      }
      const until = new Date(Date.now() + 5 * 60000);
      await tx.session.update({ where: { id: r.sessionId }, data: { revealUntil: until } });
      return until;
    });
    return { revealUntil };
  }
  async lock(r: UserRequest) {
    await this.db.session.update({ where: { id: r.sessionId }, data: { revealUntil: null } });
    return { ok: true };
  }
  async logout(req: Request, res: Response) {
    await this.auth.logout(req, res);
    return { ok: true };
  }
}

@Controller('api')
export class AuthController {
  constructor(private service: AuthBusinessService) {}
  @Public() @Get('health') health() {
    return this.service.health();
  }
  @Public() @Post('auth/register') async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.register(body, req, res);
  }
  @Public() @Post('auth/login') async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.login(body, req, res);
  }
  @Get('auth/me') async me(@Req() req: UserRequest) {
    return this.service.me(req);
  }
  @Patch('auth/credentials') async changeCredentials(
    @Req() r: UserRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.changeCredentials(r, body, res);
  }
  @Post('auth/activity') async activity(@Req() r: UserRequest) {
    return this.service.activity(r);
  }
  @Post('auth/reveal') async reveal(@Req() r: UserRequest, @Body() b: unknown) {
    return this.service.reveal(r, b);
  }
  @Post('auth/lock') async lock(@Req() r: UserRequest) {
    return this.service.lock(r);
  }
  @Post('auth/logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.service.logout(req, res);
  }
}
