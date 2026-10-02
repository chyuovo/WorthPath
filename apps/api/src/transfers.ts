import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Database } from './database';
import { UserRequest } from './auth';
import { transferInput, toBusinessDate } from './validation';
import { businessTime } from './calculation';
@Controller('api/transfers')
export class TransfersController {
  constructor(private db: Database) {}
  @Get() async list(@Req() r: UserRequest) {
    const visibility = { userId: r.userId, ...(r.revealed ? {} : { hidden: false }) };
    const rows = await this.db.transfer.findMany({
      where: { userId: r.userId, source: visibility, target: visibility },
      include: { source: { select: { name: true } }, target: { select: { name: true } } },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(({ userId, importedFromId, effectiveDate, ...v }) => ({
      ...v,
      date: businessTime(effectiveDate),
    }));
  }
  @Post() async create(@Req() r: UserRequest, @Body() body: unknown) {
    const v = transferInput.parse(body),
      when = toBusinessDate(v.date);
    return this.db.$transaction(
      async (tx) => {
        if (v.requestId) {
          const existing = await tx.transfer.findFirst({
            where: { id: v.requestId, userId: r.userId },
          });
          if (existing) {
            if (
              existing.sourceId !== v.sourceId ||
              existing.targetId !== v.targetId ||
              !new Decimal(existing.amount.toString()).eq(v.amount) ||
              !new Decimal(existing.received.toString()).eq(v.received) ||
              !new Decimal(existing.fee.toString()).eq(v.fee) ||
              +existing.effectiveDate !== +when ||
              existing.notes !== v.notes
            )
              throw new ConflictException('转账请求标识已使用，请刷新后重试');
            return { id: existing.id };
          }
        }
        const accounts = await tx.position.findMany({
          where: {
            id: { in: [v.sourceId, v.targetId] },
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
        if (accounts.length !== 2)
          throw new BadRequestException('只能在自己的启用资产账户之间转账（隐藏账户须先解锁）');
        const source = accounts.find((p) => p.id === v.sourceId)!,
          target = accounts.find((p) => p.id === v.targetId)!;
        if (accounts.some((p) => !p.revisions[0] || +p.revisions[0].effectiveDate > +when))
          throw new ConflictException('转账时间不能早于任一账户的最新余额记录，请以当前余额转账');
        if (source.currency === target.currency && !new Decimal(v.amount).eq(v.received))
          throw new BadRequestException('同币种转出与到账金额必须一致，手续费单独填写');
        const debit = new Decimal(v.amount).plus(v.fee),
          before = new Decimal(source.revisions[0].amount.toString());
        if (before.lt(debit)) throw new BadRequestException('转出账户余额不足（含手续费）');
        const after = new Decimal(target.revisions[0].amount.toString()).plus(v.received);
        if (after.gte('10000000000000000'))
          throw new BadRequestException('到账后的金额超出支持范围');
        const outgoing = await tx.revision.create({
          data: {
            positionId: source.id,
            amount: before.minus(debit).toFixed(),
            effectiveDate: when,
            notes: v.notes,
            reason: 'transfer_out',
          },
        });
        const incoming = await tx.revision.create({
          data: {
            positionId: target.id,
            amount: after.toFixed(),
            effectiveDate: when,
            notes: v.notes,
            reason: 'transfer_in',
          },
        });
        const row = await tx.transfer.create({
          data: {
            id: v.requestId,
            userId: r.userId,
            sourceId: source.id,
            targetId: target.id,
            sourceRevisionId: outgoing.id,
            targetRevisionId: incoming.id,
            sourceCurrency: source.currency,
            targetCurrency: target.currency,
            amount: v.amount,
            received: v.received,
            fee: v.fee,
            effectiveDate: when,
            notes: v.notes,
          },
        });
        return { id: row.id };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
