import {
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Req,
  Body,
  Param,
  Query,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { Database } from './database';
import { UserRequest } from './auth';
import { adminCreateInput, adminUpdateInput } from './user-access';

const summary = {
  id: true,
  username: true,
  role: true,
  banned: true,
  mustChangePassword: true,
  createdAt: true,
} as const;
@Injectable()
export class AdminService {
  constructor(private db: Database) {}
  private async requireAdmin(userId: string) {
    const u = await this.db.user.findUnique({ where: { id: userId } });
    if (!u || u.role !== 'admin' || u.banned || u.mustChangePassword)
      throw new ForbiddenException('需要已完成改密的管理员账号');
  }
  async list(r: UserRequest, query: unknown) {
    await this.requireAdmin(r.userId);
    const p = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(query);
    const [items, total] = await Promise.all([
      this.db.user.findMany({
        select: summary,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        skip: p.offset,
        take: p.limit,
      }),
      this.db.user.count(),
    ]);
    return { items, total, offset: p.offset, limit: p.limit };
  }
  async create(r: UserRequest, body: unknown) {
    await this.requireAdmin(r.userId);
    const v = adminCreateInput.parse(body);
    const passwordHash = await hash(v.password, 12);
    return this.db.serial(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${r.userId} FOR UPDATE`);
      const actor = await tx.user.findUniqueOrThrow({ where: { id: r.userId } });
      if (actor.role !== 'admin' || actor.banned || actor.mustChangePassword)
        throw new ForbiddenException('管理员权限已变更');
      return tx.user.create({
        data: { username: v.username, passwordHash, role: v.role, mustChangePassword: true },
        select: summary,
      });
    });
  }
  async update(r: UserRequest, id: string, body: unknown) {
    z.string().uuid().parse(id);
    const v = adminUpdateInput.parse(body);
    await this.requireAdmin(r.userId);
    if (id === r.userId) throw new ForbiddenException('不能修改自己的系统权限或封禁自己');
    return this.db.serial(async (tx) => {
      // Serialize administrator changes, including two administrators changing each other.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE role='admin' ORDER BY id FOR UPDATE`);
      const actor = await tx.user.findUniqueOrThrow({ where: { id: r.userId } });
      if (actor.role !== 'admin' || actor.banned || actor.mustChangePassword)
        throw new ForbiddenException('管理员权限已变更');
      const target = await tx.user.findUnique({ where: { id } });
      if (!target) throw new NotFoundException('账号不存在');
      if (
        target.role === 'admin' &&
        !target.banned &&
        (v.banned || (v.role && v.role !== 'admin')) &&
        (await tx.user.count({ where: { role: 'admin', banned: false } })) <= 1
      )
        throw new ForbiddenException('必须保留至少一个可用管理员');
      const result = await tx.user.update({ where: { id }, data: v, select: summary });
      if (result.role !== target.role || result.banned !== target.banned) {
        await tx.session.deleteMany({ where: { userId: id } });
        await tx.agentGrant.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await tx.agentAuthorization.updateMany({
          where: { userId: id, status: { in: ['pending', 'approved'] } },
          data: { status: 'cancelled' },
        });
        await tx.agentOperation.updateMany({
          where: { userId: id, status: 'pending' },
          data: { status: 'cancelled', completedAt: new Date() },
        });
      }
      return result;
    });
  }
}
@Controller('api/admin/users')
export class AdminController {
  constructor(private service: AdminService) {}
  @Get() list(@Req() r: UserRequest, @Query() q: unknown) {
    return this.service.list(r, q);
  }
  @Post() create(@Req() r: UserRequest, @Body() b: unknown) {
    return this.service.create(r, b);
  }
  @Patch(':id') update(@Req() r: UserRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.service.update(r, id, b);
  }
}
