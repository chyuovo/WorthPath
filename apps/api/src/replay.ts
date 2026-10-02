import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { movementDeltas, type Movement } from './movement';
import { pairedReasons } from './validation';

// Lock all affected positions in the same order as movement creation. Absolute
// balance observations remain anchors; transfers and expenses retain their delta.
export async function captureReplay(tx: Prisma.TransactionClient, userId: string, ids: string[]) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM Position WHERE userId = ${userId}
    AND id IN (${Prisma.join([...ids].sort())}) ORDER BY id FOR UPDATE`);
  const rows = await tx.revision.findMany({
    where: { positionId: { in: ids }, position: { userId } },
    orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }],
  });
  const deltas = new Map<string, Decimal>();
  const balances = new Map<string, Decimal>();
  for (const row of rows) {
    if (row.reason === 'scheduled_expense')
      deltas.set(
        row.id,
        new Decimal(row.amount.toString()).minus(balances.get(row.positionId) || 0),
      );
    balances.set(row.positionId, new Decimal(row.amount.toString()));
  }
  return async () => {
    const transfers = await tx.transfer.findMany({
      where: { userId, OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }] },
    });
    for (const t of transfers) {
      const d = movementDeltas(
        t.operation as Movement,
        t.amount.toString(),
        t.received.toString(),
        t.fee.toString(),
      );
      deltas.set(t.sourceRevisionId, d.source);
      deltas.set(t.targetRevisionId, d.target);
    }
    const positions = await tx.position.findMany({ where: { userId, id: { in: ids } } });
    const current = await tx.revision.findMany({
      where: { positionId: { in: ids }, position: { userId } },
      orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }],
    });
    balances.clear();
    for (const row of current) {
      const p = positions.find((v) => v.id === row.positionId)!;
      const delta =
        row.reason === 'scheduled_expense' || pairedReasons.includes(row.reason)
          ? deltas.get(row.id)
          : undefined;
      if (pairedReasons.includes(row.reason) && !delta)
        throw new ConflictException('配对记录不完整，无法重算');
      if (delta && !balances.has(row.positionId))
        throw new ConflictException('资金操作之前必须保留一条余额记录');
      const amount = delta
        ? balances.get(row.positionId)!.plus(delta)
        : new Decimal(row.amount.toString());
      if (amount.isNegative() && (p.kind !== 'account' || p.side !== 'asset'))
        throw new BadRequestException('修改后债务或资产金额不能为负数');
      if (amount.abs().gte('10000000000000000'))
        throw new BadRequestException('重算后的金额超出支持范围');
      balances.set(row.positionId, amount);
      if (!amount.eq(row.amount.toString()))
        await tx.revision.update({ where: { id: row.id }, data: { amount: amount.toFixed() } });
    }
  };
}
