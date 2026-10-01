import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Database } from './database';
import { UserRequest } from './auth';
import { positionInput, positionMeta, currency, revisionInput, rateInput } from './validation';
import { day } from './calculation';
const timestamp = z.iso
  .datetime()
  .refine(
    (s) => s >= '1900-01-01T00:00:00.000Z' && new Date(s).getTime() <= Date.now() + 60000,
    '创建和更新时间无效',
  );
const record = positionMeta
  .extend({
    kind: z.enum(['account', 'asset', 'debt']),
    side: z.enum(['asset', 'liability']),
    currency,
    id: z.string().uuid(),
    importedFromId: z.string().uuid().nullable().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revisions: z
      .array(
        revisionInput.extend({
          id: z.string().uuid(),
          sequence: z.number().int().positive().max(2147483647).optional(),
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      )
      .min(1)
      .max(10000),
  })
  .strict();
const backupSchema = z
  .object({
    format: z.literal('worthpath'),
    version: z.literal(1),
    exportedAt: z.iso.datetime(),
    baseCurrency: currency,
    currencies: z.array(currency).max(10),
    positions: z.array(record).max(1000),
    links: z
      .array(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }).strict())
      .max(20000),
    rates: z.array(rateInput.safeExtend({ source: z.enum(['manual', 'frankfurter']) })).max(20000),
  })
  .strict();
type Backup = z.infer<typeof backupSchema>;
export function validateBackup(raw: unknown) {
  const b = backupSchema.parse(raw),
    ids = new Map(b.positions.map((p) => [p.id, p]));
  if (ids.size !== b.positions.length) throw new BadRequestException('重复项目 ID');
  if (b.positions.reduce((n, p) => n + p.revisions.length, 0) > 20000)
    throw new BadRequestException('单次备份最多 20000 条历史');
  const origins = b.positions.map((p) => p.importedFromId || p.id);
  if (new Set(origins).size !== origins.length) throw new BadRequestException('备份内包含重复项目');
  const revisionIds = new Set<string>();
  for (const p of b.positions) {
    positionInput.parse({
      name: p.name,
      category: p.category,
      kind: p.kind,
      side: p.side,
      currency: p.currency,
      notes: p.notes,
      archived: p.archived,
      amount: '0',
      date: p.revisions[0].date,
    });
    const sequences = new Set<number>();
    for (const r of p.revisions) {
      if (revisionIds.has(r.id) || (r.sequence !== undefined && sequences.has(r.sequence)))
        throw new BadRequestException('重复历史记录');
      if (r.sequence !== undefined) sequences.add(r.sequence);
      revisionIds.add(r.id);
    }
    if (!b.currencies.includes(p.currency)) throw new BadRequestException('币种清单不完整');
  }
  const links = new Set<string>();
  for (const l of b.links) {
    const s = ids.get(l.sourceId),
      t = ids.get(l.targetId),
      key = l.sourceId + l.targetId;
    if (!s || !t || s.kind !== 'debt' || t.kind === 'debt' || s.id === t.id || links.has(key))
      throw new BadRequestException('关联关系无效');
    links.add(key);
  }
  const rates = new Set<string>();
  for (const r of b.rates) {
    const key = `${r.currency}/${r.baseCurrency}/${r.date}`;
    if (rates.has(key)) throw new BadRequestException('重复汇率');
    rates.add(key);
    if (!b.currencies.includes(r.currency) || !b.currencies.includes(r.baseCurrency))
      throw new BadRequestException('币种清单不完整');
  }
  if (!b.currencies.includes(b.baseCurrency)) throw new BadRequestException('本位币清单不完整');
  return b;
}
@Controller('api/backup')
export class BackupController {
  constructor(private db: Database) {}
  private async data(userId: string): Promise<Backup> {
    const [user, ps, rates] = await this.db.$transaction([
      this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { baseCurrency: true },
      }),
      this.db.position.findMany({
        where: { userId },
        include: { revisions: true, outgoing: true },
      }),
      this.db.exchangeRate.findMany({ where: { userId } }),
    ]);
    const positions = ps.map((p) => ({
      id: p.id,
      importedFromId: p.importedFromId,
      name: p.name,
      kind: p.kind,
      side: p.side,
      category: p.category,
      currency: p.currency,
      notes: p.notes,
      archived: p.archived,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      revisions: p.revisions.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        amount: r.amount.toString(),
        date: day(r.effectiveDate),
        notes: r.notes,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }));
    return backupSchema.parse({
      format: 'worthpath',
      version: 1,
      exportedAt: new Date().toISOString(),
      baseCurrency: user.baseCurrency,
      currencies: [
        ...new Set([
          user.baseCurrency,
          ...ps.map((p) => p.currency),
          ...rates.flatMap((r) => [r.currency, r.baseCurrency]),
        ]),
      ],
      positions,
      links: ps.flatMap((p) =>
        p.outgoing.map((l) => ({ sourceId: l.sourceId, targetId: l.targetId })),
      ),
      rates: rates.map((r) => ({
        currency: r.currency,
        baseCurrency: r.baseCurrency,
        date: day(r.date),
        rate: r.rate.toString(),
        source: r.source,
      })),
    });
  }
  @Get() async download(@Req() r: UserRequest, @Res() res: Response) {
    const b = await this.data(r.userId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="worthpath-${b.exportedAt.slice(0, 10)}.json"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(JSON.stringify(b, null, 2));
  }
  @Post('preview') async preview(@Req() r: UserRequest, @Body() raw: unknown) {
    const b = validateBackup(raw),
      existing = await this.data(r.userId);
    this.conflicts(b, existing);
    return {
      positions: b.positions.length,
      revisions: b.positions.reduce((n, p) => n + p.revisions.length, 0),
      rates: b.rates.length,
      baseCurrency: b.baseCurrency,
      currentBaseCurrency: existing.baseCurrency,
      message:
        '只追加新项目并重建关联，相同汇率保留。不会覆盖已有项目。已有本位币保留，空账户恢复备份本位币。确认后以事务导入。',
    };
  }
  private conflicts(b: Backup, existing: Backup) {
    const ids = new Set(
      existing.positions.flatMap((p) => [p.id, p.importedFromId].filter(Boolean)),
    );
    if (b.positions.some((p) => ids.has(p.id) || ids.has(p.importedFromId || p.id)))
      throw new ConflictException('包含已有或重复项目，请勿重复导入；首版只支持追加新项目');
    for (const rate of b.rates) {
      const e = existing.rates.find(
        (r) =>
          r.currency === rate.currency &&
          r.baseCurrency === rate.baseCurrency &&
          r.date === rate.date,
      );
      if (e && !new Decimal(e.rate).eq(rate.rate))
        throw new ConflictException('已有同日汇率与备份冲突，未修改数据');
    }
  }
  @Post('import') async restore(@Req() r: UserRequest, @Body() raw: unknown) {
    const { backup } = z
        .object({ confirmed: z.literal(true), backup: backupSchema })
        .strict()
        .parse(raw),
      b = validateBackup(backup);
    return this.db.$transaction(
      async (tx) => {
        const ps = await tx.position.findMany({
            where: { userId: r.userId },
            include: { revisions: true },
          }),
          rs = await tx.exchangeRate.findMany({ where: { userId: r.userId } });
        const existing = {
          positions: ps.map((p) => ({
            ...p,
            revisions: p.revisions.map((v) => ({
              ...v,
              amount: v.amount.toString(),
              date: day(v.effectiveDate),
            })),
          })),
          rates: rs.map((v) => ({ ...v, rate: v.rate.toString(), date: day(v.date) })),
        } as unknown as Backup;
        this.conflicts(b, existing);
        const mapping = new Map<string, string>();
        for (const p of b.positions) {
          const row = await tx.position.create({
            data: {
              userId: r.userId,
              importedFromId: p.importedFromId || p.id,
              name: p.name,
              kind: p.kind,
              side: p.side,
              category: p.category,
              currency: p.currency,
              notes: p.notes,
              archived: p.archived,
              createdAt: new Date(p.createdAt),
              updatedAt: new Date(p.updatedAt),
              revisions: {
                create: [...p.revisions]
                  .sort(
                    (a, b) =>
                      a.date.localeCompare(b.date) ||
                      (a.sequence || 0) - (b.sequence || 0) ||
                      a.createdAt.localeCompare(b.createdAt),
                  )
                  .map((v) => ({
                    amount: v.amount,
                    effectiveDate: new Date(v.date),
                    notes: v.notes,
                    reason: v.reason,
                    createdAt: new Date(v.createdAt),
                    updatedAt: new Date(v.updatedAt),
                  })),
              },
            },
          });
          mapping.set(p.id, row.id);
        }
        for (const l of b.links)
          await tx.positionLink.create({
            data: { sourceId: mapping.get(l.sourceId)!, targetId: mapping.get(l.targetId)! },
          });
        for (const v of b.rates) {
          const key = {
            userId: r.userId,
            currency: v.currency,
            baseCurrency: v.baseCurrency,
            date: new Date(v.date),
          };
          await tx.exchangeRate.upsert({
            where: { userId_currency_baseCurrency_date: key },
            create: { ...key, rate: v.rate, source: v.source },
            update: {},
          });
        }
        if (!ps.length && !rs.length)
          await tx.user.update({ where: { id: r.userId }, data: { baseCurrency: b.baseCurrency } });
        return { ok: true, positions: b.positions.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30000 },
    );
  }
}
