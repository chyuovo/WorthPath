import {
  Injectable,
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { hash, compare } from 'bcryptjs';
import { Database } from './database';
import { credentials } from './validation';
export type UserRequest = Request & { userId: string };
const Public = () => SetMetadata('public', true);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
@Injectable()
export class AuthService {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(private db: Database) {}
  limit(req: Request) {
    const key = req.ip || 'local',
      now = Date.now();
    let v = this.attempts.get(key);
    if (!v || v.until < now) {
      v = { count: 0, until: now + 900000 };
      this.attempts.set(key, v);
    }
    if (++v.count > 30) throw new HttpException('尝试过于频繁，请 15 分钟后重试', 429);
    if (this.attempts.size > 10000) {
      for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
      if (this.attempts.size > 10000) throw new HttpException('服务繁忙，请稍后重试', 429);
    }
  }
  async issue(userId: string, res: Response) {
    const token = randomBytes(32).toString('hex'),
      expiresAt = new Date(Date.now() + 7 * 86400000);
    await this.db.session.create({ data: { id: digest(token), userId, expiresAt } });
    res.cookie('wp_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      expires: expiresAt,
      path: '/api',
    });
  }
  async user(token: unknown) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = await this.db.session.findUnique({ where: { id: digest(token) } });
    return s && s.expiresAt > new Date() ? s.userId : null;
  }
  async logout(req: Request, res: Response) {
    if (typeof req.cookies?.wp_session === 'string')
      await this.db.session.deleteMany({ where: { id: digest(req.cookies.wp_session) } });
    res.clearCookie('wp_session', {
      path: '/api',
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      httpOnly: true,
    });
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
      req.headers.origin !== process.env.WEB_ORIGIN
    )
      throw new ForbiddenException('请求来源不受信任');
    if (this.reflector.get<boolean>('public', ctx.getHandler())) return true;
    const id = await this.auth.user(req.cookies?.wp_session);
    if (!id) throw new UnauthorizedException('请先登录');
    req.userId = id;
    return true;
  }
}
@Controller('api')
export class AuthController {
  constructor(
    private db: Database,
    private auth: AuthService,
  ) {}
  @Public() @Get('health') health() {
    return { status: 'ok' };
  }
  @Public() @Post('auth/register') async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.limit(req);
    const v = credentials.parse(body),
      user = await this.db.user.create({
        data: { username: v.username, passwordHash: await hash(v.password, 12) },
      });
    await this.auth.issue(user.id, res);
    return { username: user.username, baseCurrency: user.baseCurrency };
  }
  @Public() @Post('auth/login') async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.auth.limit(req);
    const v = credentials.parse(body),
      user = await this.db.user.findUnique({ where: { username: v.username } });
    const ok = await compare(
      v.password,
      user?.passwordHash || '$2b$12$JZKvzAzfqM3obKxMQTFBjOzqIIKG97kn96/xUMbgTuWUnlMAT2bSi',
    );
    if (!user || !ok) throw new UnauthorizedException('账号或密码错误');
    await this.auth.issue(user.id, res);
    return { username: user.username, baseCurrency: user.baseCurrency };
  }
  @Get('auth/me') async me(@Req() req: UserRequest) {
    return this.db.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: { username: true, baseCurrency: true },
    });
  }
  @Post('auth/logout') async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req, res);
    return { ok: true };
  }
}
