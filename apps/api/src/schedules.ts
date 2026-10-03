import { Injectable } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Req,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Database } from './database';
import { UserRequest } from './auth';
import { amount, notes, transferInput } from './validation';
import { businessTime } from './calculation';
import { executeMovement } from './transfers';
export const scheduleInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    operation: z.enum(['expense', 'transfer']),
    sourceId: z.string().uuid(),
    targetId: z.string().uuid().nullable().default(null),
    amount: amount.refine((v) => new Decimal(v).gt(0), '金额必须大于零'),
    received: amount.default('0'),
    nextAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
      .refine((s) => {
        const d = new Date(s + ':00+08:00');
        return (
          Number.isFinite(+d) && businessTime(d) === s && s >= '1900-01-01' && s < '9999-01-01'
        );
      }, '计划时间无效'),
    intervalDays: z.coerce.number().int().min(0).max(3650),
    notes,
  })
  .strict()
  .refine(
    (v) =>
      v.operation !== 'transfer' ||
      (!!v.targetId && v.sourceId !== v.targetId && new Decimal(v.received).gt(0)),
    '转账计划须选择不同账户并填写到账金额',
  );
export function occurrenceId(id: string, when: Date) {
  const hex = createHash('sha256')
    .update(id + ':' + when.toISOString())
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function nextOccurrence(when: Date, intervalDays: number) {
  return new Date(+when + intervalDays * 86400000);
}

@Injectable()
export class SchedulesBusinessService {
  constructor(private db: Database) {}
  private async visible(r: UserRequest, tx: Prisma.TransactionClient = this.db) {
    return (
      await tx.position.findMany({
        where: {
          userId: r.userId,
          kind: 'account',
          ...(r.revealed ? {} : { hidden: false }),
        },
        select: { id: true },
      })
    ).map((p) => p.id);
  }
  async list(r: UserRequest) {
    const ids = await this.visible(r);
    const rows = await this.db.schedule.findMany({
      where: {
        userId: r.userId,
        sourceId: { in: ids },
        OR: [{ targetId: null }, { targetId: { in: ids } }],
      },
      orderBy: [{ nextAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ userId, ...v }) => ({ ...v, nextAt: businessTime(v.nextAt) }));
  }
  async create(r: UserRequest, body: unknown) {
    const v = scheduleInput.parse(body);
    return this.db.serial(async (tx) => {
      await this.validateAccounts(tx, r, v);
      return tx.schedule.create({
        data: { ...v, userId: r.userId, nextAt: new Date(v.nextAt + ':00+08:00') },
        select: { id: true },
      });
    });
  }
  private async validateAccounts(
    tx: Prisma.TransactionClient,
    r: UserRequest,
    v: z.infer<typeof scheduleInput>,
  ) {
    const ids = [v.sourceId, ...(v.targetId ? [v.targetId] : [])].sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM Position WHERE userId = ${r.userId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
    );
    const accounts = await tx.position.findMany({
      where: {
        userId: r.userId,
        id: { in: ids },
        kind: 'account',
        ...(v.operation === 'expense' ? { side: 'asset' } : {}),
        archived: false,
        ...(r.revealed ? {} : { hidden: false }),
      },
    });
    if (accounts.length !== ids.length)
      throw new BadRequestException('请选择启用的账户（支出计划使用资产账户）');
    if (v.operation === 'expense' && v.targetId)
      throw new BadRequestException('支出计划无需转入账户');
    if (
      v.operation === 'transfer' &&
      accounts[0].currency === accounts[1].currency &&
      !new Decimal(v.amount).eq(v.received)
    )
      throw new BadRequestException('同币种转出与到账金额必须一致');
  }
  async edit(r: UserRequest, id: string, body: unknown) {
    const v = scheduleInput.parse(body);
    return this.db.serial(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM Schedule WHERE id = ${id} AND userId = ${r.userId} FOR UPDATE`,
      );
      const ids = await this.visible(r, tx);
      const row = await tx.schedule.findFirst({
        where: {
          id,
          userId: r.userId,
          sourceId: { in: ids },
          OR: [{ targetId: null }, { targetId: { in: ids } }],
        },
      });
      if (!row) throw new NotFoundException('计划不存在');
      if (row.completed) throw new BadRequestException('一次性计划已完成，请新建计划');
      await this.validateAccounts(tx, r, v);
      await tx.schedule.update({
        where: { id },
        data: { ...v, nextAt: new Date(v.nextAt + ':00+08:00') },
      });
      return { ok: true };
    });
  }
  async toggle(r: UserRequest, id: string, body: unknown) {
    const v = z.object({ enabled: z.boolean() }).strict().parse(body);
    const ids = await this.visible(r);
    const row = await this.db.schedule.findFirst({
      where: {
        id,
        userId: r.userId,
        sourceId: { in: ids },
        OR: [{ targetId: null }, { targetId: { in: ids } }],
      },
    });
    if (row?.completed && v.enabled) throw new BadRequestException('一次性计划已完成，请新建计划');
    const result = await this.db.schedule.updateMany({
      where: {
        id,
        userId: r.userId,
        sourceId: { in: ids },
        OR: [{ targetId: null }, { targetId: { in: ids } }],
      },
      data: v,
    });
    if (!result.count) throw new NotFoundException('计划不存在');
    return { ok: true };
  }
  async remove(r: UserRequest, id: string) {
    const ids = await this.visible(r);
    const result = await this.db.schedule.deleteMany({
      where: {
        id,
        userId: r.userId,
        sourceId: { in: ids },
        OR: [{ targetId: null }, { targetId: { in: ids } }],
      },
    });
    if (!result.count) throw new NotFoundException('计划不存在');
    return { ok: true };
  }
  async run(r: UserRequest, atomicBatch = false) {
    const ids = await this.visible(r),
      now = new Date();
    const due = await this.db.schedule.findMany({
      where: {
        userId: r.userId,
        enabled: true,
        nextAt: { lte: now },
        sourceId: { in: ids },
        OR: [{ targetId: null }, { targetId: { in: ids } }],
      },
      orderBy: [{ nextAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    let executed = 0;
    const errors: { id: string; message: string }[] = [];
    for (const candidate of due) {
      try {
        const applied = await this.db.serial(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM Schedule WHERE id = ${candidate.id} AND userId = ${r.userId} FOR UPDATE`,
          );
          const plan = await tx.schedule.findFirst({
            where: { id: candidate.id, userId: r.userId, enabled: true, nextAt: { lte: now } },
          });
          if (!plan || +plan.nextAt !== +candidate.nextAt) return false;
          // Execute against current balances; retain the intended time in the note.
          const date = businessTime(now),
            requestId = occurrenceId(plan.id, plan.nextAt);
          const memo =
            `计划：${plan.name} · 应执行时间 ${businessTime(plan.nextAt)}\n${plan.notes}`.slice(
              0,
              2000,
            );
          if (plan.operation === 'transfer') {
            await executeMovement(
              tx,
              r,
              transferInput.parse({
                sourceId: plan.sourceId,
                targetId: plan.targetId,
                amount: plan.amount.toString(),
                received: plan.received.toString(),
                fee: '0',
                date,
                notes: memo,
                requestId,
              }),
            );
          } else {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM Position WHERE id = ${plan.sourceId} AND userId = ${r.userId} FOR UPDATE`,
            );
            const account = await tx.position.findFirst({
              where: {
                id: plan.sourceId,
                userId: r.userId,
                kind: 'account',
                side: 'asset',
                archived: false,
                ...(r.revealed ? {} : { hidden: false }),
              },
              include: {
                revisions: { orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }], take: 1 },
              },
            });
            if (!account) throw new BadRequestException('计划账户已归档或不可用');
            const after = new Decimal(account.revisions[0]?.amount.toString() || '0').minus(
              plan.amount.toString(),
            );
            if (after.abs().gte('10000000000000000'))
              throw new BadRequestException('变更后的金额超出支持范围');
            await tx.revision.create({
              data: {
                id: requestId,
                positionId: account.id,
                amount: after.toFixed(),
                effectiveDate: new Date(date + ':00+08:00'),
                notes: memo,
                reason: 'scheduled_expense',
              },
            });
          }
          const nextAt = nextOccurrence(plan.nextAt, plan.intervalDays);
          await tx.schedule.update({
            where: { id: plan.id },
            data: plan.intervalDays ? { nextAt } : { enabled: false, completed: true },
          });
          return true;
        });
        if (applied) executed++;
      } catch (e) {
        // MCP wraps the complete call plus its idempotency result in one transaction.
        // A failed nested plan must abort that batch rather than leave partial work.
        if (atomicBatch) throw e;
        errors.push({
          id: candidate.id,
          message:
            e instanceof BadRequestException ? e.message : '计划未执行，请刷新或检查账户状态后重试',
        });
      }
    }
    return {
      executed,
      errors,
      hasMore:
        due.length === 20 ||
        due.some((p) => p.intervalDays > 0 && +nextOccurrence(p.nextAt, p.intervalDays) <= +now),
    };
  }
}

@Controller('api/schedules')
export class SchedulesController {
  constructor(private service: SchedulesBusinessService) {}
  @Get() async list(@Req() r: UserRequest) {
    return this.service.list(r);
  }
  @Post() async create(@Req() r: UserRequest, @Body() body: unknown) {
    return this.service.create(r, body);
  }
  @Put(':id') async edit(@Req() r: UserRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.service.edit(r, id, body);
  }
  @Patch(':id') async toggle(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.toggle(r, id, body);
  }
  @Delete(':id') async remove(@Req() r: UserRequest, @Param('id') id: string) {
    return this.service.remove(r, id);
  }
  @Post('run') async run(@Req() r: UserRequest) {
    return this.service.run(r);
  }
}
