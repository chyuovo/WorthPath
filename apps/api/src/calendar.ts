import { Controller, Get, Query, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Database } from './database';
import { UserRequest } from './auth';
import { date, today, toBusinessDate } from './validation';
import { businessDay, rateAt } from './calculation';
import { currentRates, latestRevisions, endOfDay } from './queries';
export function cashflowDelta(side: string, reason: string, before: string, after: string) {
  if (!['balance', 'correction', 'scheduled_expense'].includes(reason)) return new Decimal(0);
  const delta = new Decimal(after).minus(before);
  return side === 'liability' ? delta.neg() : delta;
}
export function calendarMonth(value: unknown) {
  const month = z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine((s) => s >= '1900-01' && s <= today().slice(0, 7))
    .parse(value || today().slice(0, 7));
  const from = month + '-01',
    next = new Date(from + 'T00:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(+next - 86400000).toISOString().slice(0, 10);
  return { month, from, to: last > today() ? today() : last, days: Number(last.slice(-2)) };
}
@Controller('api/calendar')
export class CalendarController {
  constructor(private db: Database) {}
  private async replay(
    tx: Prisma.TransactionClient,
    r: UserRequest,
    from: string,
    to: string,
    details: boolean,
  ) {
    const accounts = await tx.position.findMany({
      where: { userId: r.userId, kind: 'account', ...(r.revealed ? {} : { hidden: false }) },
      select: { id: true, name: true, side: true, currency: true },
    });
    const ids = accounts.map((p) => p.id),
      seeds = await latestRevisions(tx, ids, toBusinessDate(from));
    const rows = ids.length
      ? await tx.revision.findMany({
          where: {
            positionId: { in: ids },
            effectiveDate: { gte: toBusinessDate(from), lt: endOfDay(to) },
          },
          select: {
            id: true,
            positionId: true,
            amount: true,
            effectiveDate: true,
            sequence: true,
            reason: true,
            ...(details ? { notes: true } : {}),
          },
          orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }],
        })
      : [];
    const prior = new Map(seeds.map((v) => [v.positionId, v.amount.toString()]));
    const meta = new Map(accounts.map((v) => [v.id, v]));
    const changes = rows
      .map((v) => {
        const p = meta.get(v.positionId)!;
        const hasBefore = prior.has(v.positionId);
        const before = prior.get(v.positionId) || '0';
        prior.set(v.positionId, v.amount.toString());
        return {
          id: v.id,
          name: p.name,
          currency: p.currency,
          date: businessDay(v.effectiveDate),
          delta:
            hasBefore || v.reason === 'scheduled_expense'
              ? cashflowDelta(p.side, v.reason, before, v.amount.toString())
              : new Decimal(0),
          notes: details ? (v as typeof v & { notes?: string }).notes || '' : '',
        };
      })
      .filter((v) => !v.delta.isZero());
    const user = await tx.user.findUniqueOrThrow({
      where: { id: r.userId },
      select: { baseCurrency: true },
    });
    const currencies = [...new Set(accounts.map((p) => p.currency))];
    const rates = await tx.exchangeRate.findMany({
      where: {
        userId: r.userId,
        currency: { in: currencies },
        baseCurrency: user.baseCurrency,
        date: { gte: new Date(from), lte: new Date(to) },
      },
    });
    const priorRates = await currentRates(
      tx,
      r.userId,
      currencies,
      user.baseCurrency,
      new Date(+new Date(from) - 86400000).toISOString().slice(0, 10),
    );
    const allRates = [...priorRates, ...rates];
    return {
      baseCurrency: user.baseCurrency,
      changes: changes.map((v) => {
        const rate = rateAt(allRates, v.currency, user.baseCurrency, v.date);
        return {
          ...v,
          amount: v.delta.abs().toFixed(),
          direction: v.delta.isNegative() ? 'expense' : 'income',
          converted: rate ? v.delta.abs().mul(rate.value).toFixed() : null,
        };
      }),
    };
  }
  @Get() async month(@Req() r: UserRequest, @Query('month') input?: string) {
    const q = calendarMonth(input);
    return this.db.$transaction(
      async (tx) => {
        const data = await this.replay(tx, r, q.from, q.to, false);
        const items = Array.from({ length: q.days }, (_, i) => ({
          date: q.month + '-' + String(i + 1).padStart(2, '0'),
          income: new Decimal(0),
          expense: new Decimal(0),
          complete: true,
        }));
        for (const v of data.changes) {
          const item = items[Number(v.date.slice(-2)) - 1];
          if (v.converted === null) item.complete = false;
          else if (v.direction === 'income') item.income = item.income.plus(v.converted);
          else item.expense = item.expense.plus(v.converted);
        }
        return {
          month: q.month,
          baseCurrency: data.baseCurrency,
          revealed: r.revealed,
          items: items.map((v) => ({
            ...v,
            income: v.income.toFixed(2),
            expense: v.expense.toFixed(2),
          })),
        };
      },
      { timeout: 30000 },
    );
  }
  @Get('day') async day(@Req() r: UserRequest, @Query('date') input?: string) {
    const day = date.parse(input || today());
    return this.db.$transaction(
      async (tx) => {
        const data = await this.replay(tx, r, day, day, true);
        return {
          date: day,
          baseCurrency: data.baseCurrency,
          revealed: r.revealed,
          items: data.changes.map(({ delta, ...v }) => v),
        };
      },
      { timeout: 30000 },
    );
  }
}
