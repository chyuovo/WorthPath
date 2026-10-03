import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  NotFoundException,
  Body,
  Req,
  Query,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Database } from './database';
import { UserRequest } from './auth';
import { transferInput, toBusinessDate } from './validation';
import { businessTime } from './calculation';
import { movementDeltas } from './movement';
import { captureReplay } from './replay';
import { pageInput, encodeCursor, latestRevisions, transferPageIds } from './queries';
@Controller('api/transfers')
export class TransfersController {
  constructor(private db: Database) {}
  @Get() async list(@Req() r: UserRequest, @Query() query: unknown) {
    const q = pageInput(query);
    const rows = await this.db.$transaction(async (tx) => {
      const ids = await transferPageIds(tx, r.userId, r.revealed, q);
      return tx.transfer.findMany({
        where: { userId: r.userId, id: { in: ids.map((row) => row.id) } },
        include: {
          source: { select: { name: true, kind: true } },
          target: { select: { name: true, kind: true } },
        },
        orderBy: [{ effectiveDate: 'desc' }, { id: 'desc' }],
      });
    });
    const items = rows.slice(0, q.limit).map(({ userId, importedFromId, effectiveDate, ...v }) => ({
      ...v,
      date: businessTime(effectiveDate),
    }));
    const last = rows[q.limit - 1];
    return {
      items,
      nextCursor: rows.length > q.limit ? encodeCursor(last.effectiveDate, last.id) : null,
      revealed: r.revealed,
    };
  }
  @Get('revision/:revisionId') async byRevision(
    @Req() r: UserRequest,
    @Param('revisionId') revisionId: string,
  ) {
    const row = await this.db.transfer.findFirst({
      where: {
        userId: r.userId,
        OR: [{ sourceRevisionId: revisionId }, { targetRevisionId: revisionId }],
        ...(r.revealed ? {} : { source: { hidden: false }, target: { hidden: false } }),
      },
      include: {
        source: { select: { name: true, kind: true } },
        target: { select: { name: true, kind: true } },
      },
    });
    if (!row) throw new NotFoundException('资金往来记录不存在');
    const { userId, importedFromId, effectiveDate, ...v } = row;
    return { ...v, date: businessTime(effectiveDate) };
  }
  @Put(':id') async edit(@Req() r: UserRequest, @Param('id') id: string, @Body() body: unknown) {
    const v = transferInput.parse(body);
    return this.change(r, id, v);
  }
  @Delete(':id') async remove(@Req() r: UserRequest, @Param('id') id: string) {
    return this.change(r, id);
  }
  private async change(r: UserRequest, id: string, v?: ReturnType<typeof transferInput.parse>) {
    return this.db.serial(async (tx) => {
      return changeMovement(tx, r, id, v);
    });
  }
  @Post() async create(@Req() r: UserRequest, @Body() body: unknown) {
    const v = transferInput.parse(body);
    return this.db.serial((tx) => executeMovement(tx, r, v));
  }
}
export async function changeMovement(
  tx: Prisma.TransactionClient,
  r: Pick<UserRequest, 'userId' | 'revealed'>,
  id: string,
  v?: ReturnType<typeof transferInput.parse>,
) {
  const row = await tx.transfer.findFirst({
    where: {
      id,
      userId: r.userId,
      ...(r.revealed ? {} : { source: { hidden: false }, target: { hidden: false } }),
    },
    include: { source: true, target: true },
  });
  if (!row) throw new NotFoundException('资金往来记录不存在');
  if (row.source.archived || row.target.archived) throw new ConflictException('请先恢复归档项目');
  const replay = await captureReplay(tx, r.userId, [row.sourceId, row.targetId]);
  if (v) {
    if (v.sourceId !== row.sourceId || v.targetId !== row.targetId || v.operation !== row.operation)
      throw new BadRequestException('修改记录不能更换账户或操作类型，请删除后重新创建');
    if (row.sourceCurrency === row.targetCurrency && !new Decimal(v.amount).eq(v.received))
      throw new BadRequestException('同币种转出与到账金额必须一致，手续费单独填写');
    const effectiveDate = toBusinessDate(v.date);
    await tx.transfer.update({
      where: { id },
      data: {
        amount: v.amount,
        received: v.received,
        fee: v.fee,
        notes: v.notes,
        effectiveDate,
      },
    });
    await tx.revision.updateMany({
      where: { id: { in: [row.sourceRevisionId, row.targetRevisionId] } },
      data: { effectiveDate, notes: v.notes },
    });
  } else {
    await tx.transfer.delete({ where: { id } });
    await tx.revision.deleteMany({
      where: { id: { in: [row.sourceRevisionId, row.targetRevisionId] } },
    });
  }
  await replay();
  return { ok: true };
}
export async function executeMovement(
  tx: Prisma.TransactionClient,
  r: Pick<UserRequest, 'userId' | 'revealed'>,
  v: ReturnType<typeof transferInput.parse>,
) {
  const when = toBusinessDate(v.date);
  // Lock in a consistent order before reading balances or idempotency state.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM Position WHERE userId = ${r.userId}
          AND id IN (${Prisma.join([v.sourceId, v.targetId].sort())}) ORDER BY id FOR UPDATE`);
  if (v.requestId) {
    const existing = await tx.transfer.findFirst({
      where: { id: v.requestId, userId: r.userId },
    });
    if (existing) {
      if (
        existing.operation !== v.operation ||
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
  const metadata = await tx.position.findMany({
    where: {
      id: { in: [v.sourceId, v.targetId] },
      userId: r.userId,
      archived: false,
      ...(r.revealed ? {} : { hidden: false }),
    },
  });
  const latest = await latestRevisions(
    tx,
    metadata.map((p) => p.id),
    new Date('9999-01-01'),
  );
  const accounts = metadata.map((p) => ({
    ...p,
    revisions: latest.filter((r) => r.positionId === p.id),
  }));
  if (accounts.length !== 2)
    throw new BadRequestException('只能在自己的启用资产账户之间转账（隐藏账户须先解锁）');
  const source = accounts.find((p) => p.id === v.sourceId)!,
    target = accounts.find((p) => p.id === v.targetId)!;
  if (
    source.kind !== 'account' ||
    source.side !== 'asset' ||
    (v.operation === 'transfer'
      ? target.kind !== 'account' || target.side !== 'asset'
      : target.kind !== 'debt' ||
        target.side !== (['borrow', 'repay'].includes(v.operation) ? 'liability' : 'asset'))
  )
    throw new BadRequestException('请选择有效的资产账户和对应借入或借出债务');
  if (accounts.some((p) => p.revisions[0] && +p.revisions[0].effectiveDate > +when))
    throw new ConflictException('转账时间不能早于任一账户的最新余额记录，请以当前余额转账');
  if (source.currency === target.currency && !new Decimal(v.amount).eq(v.received))
    throw new BadRequestException('同币种转出与到账金额必须一致，手续费单独填写');
  const deltas = movementDeltas(v.operation, v.amount, v.received, v.fee);
  const before = new Decimal(source.revisions[0]?.amount.toString() || '0');
  const sourceAfter = before.plus(deltas.source);
  const after = new Decimal(target.revisions[0]?.amount.toString() || '0').plus(deltas.target);
  if (target.kind === 'debt' && after.isNegative())
    throw new BadRequestException('收款或还款不能超过剩余债务');
  if (after.abs().gte('10000000000000000') || sourceAfter.abs().gte('10000000000000000'))
    throw new BadRequestException('变更后的金额超出支持范围');
  const outgoing = await tx.revision.create({
    data: {
      positionId: source.id,
      amount: sourceAfter.toFixed(),
      effectiveDate: when,
      notes: v.notes,
      reason: deltas.sourceReason,
    },
  });
  const incoming = await tx.revision.create({
    data: {
      positionId: target.id,
      amount: after.toFixed(),
      effectiveDate: when,
      notes: v.notes,
      reason: deltas.targetReason,
    },
  });
  const row = await tx.transfer.create({
    data: {
      id: v.requestId,
      userId: r.userId,
      operation: v.operation,
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
  if (v.operation !== 'transfer')
    await tx.positionLink.upsert({
      where: { sourceId_targetId: { sourceId: target.id, targetId: source.id } },
      create: { sourceId: target.id, targetId: source.id },
      update: {},
    });
  return { id: row.id };
}
