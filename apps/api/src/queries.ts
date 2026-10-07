import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { date, today, toBusinessDate } from './validation';
import { Holding, Rate, businessDay, businessTime, history } from './calculation';
import Decimal from 'decimal.js';
import { BadRequestException } from '@nestjs/common';

type Reader = Prisma.TransactionClient;
export const revisionOrder = [{ effectiveDate: 'desc' }, { sequence: 'desc' }] as const;
const cursorSchema = z
  .object({ time: z.string().datetime(), key: z.string().min(1).max(64) })
  .strict();
export function pageInput(query: unknown) {
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(512).optional(),
      positionId: z.string().uuid().optional(),
      from: date.optional(),
      to: date.optional(),
    })
    .strict()
    .parse(query);
  const cursor = q.cursor
    ? cursorSchema.parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()))
    : null;
  if (q.from && q.to && q.from > q.to) throw new BadRequestException('开始日期不能晚于结束日期');
  return { ...q, cursor };
}
export const encodeCursor = (time: Date, key: string | number) =>
  Buffer.from(JSON.stringify({ time: time.toISOString(), key: String(key) })).toString('base64url');
export const endOfDay = (d: string) => new Date(+toBusinessDate(d) + 86400000);

// Use record business time, not creation time or the obsolete manual marker.
export async function accountActivityIds(
  db: Reader,
  userId: string,
  revealed: boolean,
  day: string,
) {
  const rows = await db.position.findMany({
    where: {
      userId,
      kind: 'account',
      ...(revealed ? {} : { hidden: false }),
      revisions: { some: { effectiveDate: { gte: toBusinessDate(day), lt: endOfDay(day) } } },
    },
    select: { id: true },
  });
  return new Set(rows.map((p) => p.id));
}

export async function transferPageIds(
  db: Reader,
  userId: string,
  revealed: boolean,
  q: ReturnType<typeof pageInput>,
) {
  // Keep the ordered transfer index as the driving table. A visibility JOIN can
  // otherwise make MySQL scan source accounts first and sort all their transfers.
  return db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT t.id FROM Transfer t FORCE INDEX (Transfer_userId_effectiveDate_id_idx)
    STRAIGHT_JOIN Position s ON s.id = t.sourceId
    STRAIGHT_JOIN Position d ON d.id = t.targetId
    WHERE t.userId = ${userId} AND s.userId = ${userId} AND d.userId = ${userId}
      ${revealed ? Prisma.empty : Prisma.sql`AND s.hidden = false AND d.hidden = false`}
      ${q.positionId ? Prisma.sql`AND (t.sourceId = ${q.positionId} OR t.targetId = ${q.positionId})` : Prisma.empty}
      ${q.from ? Prisma.sql`AND t.effectiveDate >= ${toBusinessDate(q.from)}` : Prisma.empty}
      ${q.to ? Prisma.sql`AND t.effectiveDate < ${endOfDay(q.to)}` : Prisma.empty}
      ${
        q.cursor
          ? Prisma.sql`AND (t.effectiveDate < ${new Date(q.cursor.time)} OR
        (t.effectiveDate = ${new Date(q.cursor.time)} AND t.id < ${q.cursor.key}))`
          : Prisma.empty
      }
    ORDER BY t.effectiveDate DESC, t.id DESC LIMIT ${q.limit + 1}`);
}

// Each branch has constant bounds so MySQL can use an index range even for a
// historical seed. Prisma 6's nested take can fetch unbounded rows for multiple parents.
export async function latestRevisions(db: Reader, ids: string[], before: Date) {
  if (!ids.length) return [];
  const result: (Holding['revisions'][number] & { positionId: string })[] = [];
  // Bound UNION size for users with many positions.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const branches = ids.slice(offset, offset + 100).map(
      (id) => Prisma.sql`
      (SELECT r.* FROM Revision r FORCE INDEX (Revision_positionId_effectiveDate_sequence_idx)
        WHERE r.positionId = ${id} AND r.effectiveDate < ${before}
        ORDER BY r.effectiveDate DESC, r.sequence DESC LIMIT 1)`,
    );
    result.push(...(await db.$queryRaw<typeof result>(Prisma.join(branches, ' UNION ALL '))));
  }
  return result;
}
export async function currentPositions(
  db: Reader,
  userId: string,
  revealed: boolean,
  id?: string,
  kind?: string,
) {
  const positions = await db.position.findMany({
    where: {
      userId,
      ...(revealed ? {} : { hidden: false }),
      ...(id ? { id } : {}),
      ...(kind ? { kind } : {}),
    },
    include: {
      outgoing: {
        where: { target: { userId, ...(revealed ? {} : { hidden: false }) } },
        include: { target: { select: { name: true, kind: true } } },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const latest = await latestRevisions(
    db,
    positions.map((p) => p.id),
    endOfDay(today()),
  );
  const byId = new Map(latest.map((r) => [r.positionId, r]));
  return positions.map((p) => ({ ...p, revisions: byId.has(p.id) ? [byId.get(p.id)!] : [] }));
}
export async function currentRates(
  db: Reader,
  userId: string,
  currencies: string[],
  base: string,
  before: string,
) {
  const rows = await Promise.all(
    [...new Set(currencies)]
      .filter((c) => c !== base)
      .map((currency) =>
        db.exchangeRate.findFirst({
          where: { userId, currency, baseCurrency: base, date: { lte: new Date(before) } },
          orderBy: { date: 'desc' },
        }),
      ),
  );
  return rows.filter((r): r is NonNullable<typeof r> => r !== null);
}
export async function historyPage(db: Reader, userId: string, revealed: boolean, query: unknown) {
  const q = pageInput(query);
  const positions = await db.position.findMany({
    where: {
      userId,
      ...(revealed ? {} : { hidden: false }),
      ...(q.positionId ? { id: q.positionId } : {}),
    },
    select: { id: true, name: true, kind: true, side: true, currency: true },
  });
  // Bound every account's index scan before merging. A global JOIN + ORDER BY can
  // sort an entire user's history (and evaluate the predecessor for every row).
  const candidates = (
    await Promise.all(
      positions.map((p) =>
        db.revision
          .findMany({
            where: {
              positionId: p.id,
              ...(q.from || q.to
                ? {
                    effectiveDate: {
                      ...(q.from ? { gte: toBusinessDate(q.from) } : {}),
                      ...(q.to ? { lt: endOfDay(q.to) } : {}),
                    },
                  }
                : {}),
              ...(q.cursor
                ? {
                    AND: [
                      {
                        OR: [
                          { effectiveDate: { lt: new Date(q.cursor.time) } },
                          {
                            effectiveDate: new Date(q.cursor.time),
                            sequence: {
                              lt: z.coerce.number().int().positive().parse(q.cursor.key),
                            },
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            },
            orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }],
            take: q.limit + 1,
          })
          .then((rows) =>
            rows.map((r) => ({
              ...r,
              name: p.name,
              kind: p.kind,
              side: p.side,
              currency: p.currency,
            })),
          ),
      ),
    )
  )
    .flat()
    .sort((a, b) => +b.effectiveDate - +a.effectiveDate || b.sequence - a.sequence)
    .slice(0, q.limit + 1);
  const predecessors = candidates.length
    ? await db.$queryRaw<{ id: string; beforeAmount: Prisma.Decimal | null }[]>(
        Prisma.join(
          candidates.map(
            (r) => Prisma.sql`SELECT ${r.id} AS id, (
      SELECT x.amount FROM Revision x FORCE INDEX (Revision_positionId_effectiveDate_sequence_idx)
        WHERE x.positionId = ${r.positionId} AND
        (x.effectiveDate < ${r.effectiveDate} OR (x.effectiveDate = ${r.effectiveDate} AND x.sequence < ${r.sequence}))
      ORDER BY x.effectiveDate DESC, x.sequence DESC LIMIT 1
    ) AS beforeAmount`,
          ),
          ' UNION ALL ',
        ),
      )
    : [];
  const prior = new Map(predecessors.map((r) => [r.id, r.beforeAmount]));
  const rows = candidates.map((r) => ({ ...r, beforeAmount: prior.get(r.id) || null }));
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map((r) => ({
    ...history({
      id: r.positionId,
      name: r.name,
      kind: r.kind,
      side: r.side,
      currency: r.currency,
      revisions: [r],
    })[0],
    before: r.beforeAmount?.toString() || '0',
    delta: new Decimal(r.amount.toString()).minus(r.beforeAmount?.toString() || '0').toFixed(),
  }));
  const last = rows[q.limit - 1];
  return {
    items,
    nextCursor: more ? encodeCursor(last.effectiveDate, last.sequence) : null,
    revealed,
  };
}

export function trendInput(query: unknown) {
  const to = today();
  const from = new Date(+new Date(to) - 89 * 86400000).toISOString().slice(0, 10);
  const q = z
    .object({
      from: date.default(from),
      to: date.default(to),
      grain: z.enum(['day', 'week', 'month']).default('day'),
    })
    .strict()
    .parse(query);
  const span = (+new Date(q.to) - +new Date(q.from)) / 86400000;
  const max = q.grain === 'day' ? 365 : q.grain === 'week' ? 1095 : 3652;
  if (span < 0 || span > max) throw new BadRequestException(`日期范围超出限制（${max + 1} 天）`);
  return q;
}
export async function trendData(
  db: Reader,
  userId: string,
  revealed: boolean,
  from: string,
  to: string,
) {
  const positions = await db.position.findMany({
    where: { userId, ...(revealed ? {} : { hidden: false }) },
  });
  const ids = positions.map((p) => p.id);
  const seeds = await latestRevisions(db, ids, toBusinessDate(from));
  // Only the final balance of each Beijing business day is needed. Rank in MySQL,
  // rather than shipping every intraday revision to Node or the browser.
  const daily = ids.length
    ? await db.$queryRaw<(Holding['revisions'][number] & { positionId: string })[]>(Prisma.sql`
    SELECT id, sequence, positionId, amount, effectiveDate, '' AS notes, 'balance' AS reason FROM (
      SELECT r.id, r.sequence, r.positionId, r.amount, r.effectiveDate,
        ROW_NUMBER() OVER (PARTITION BY r.positionId, DATE(DATE_ADD(r.effectiveDate, INTERVAL 8 HOUR))
        ORDER BY r.effectiveDate DESC, r.sequence DESC) AS rankInDay
      FROM Revision r JOIN Position p ON p.id = r.positionId
      WHERE p.userId = ${userId} ${revealed ? Prisma.empty : Prisma.sql`AND p.hidden = false`}
        AND r.effectiveDate >= ${toBusinessDate(from)} AND r.effectiveDate < ${endOfDay(to)}
    ) ranked WHERE rankInDay = 1 ORDER BY effectiveDate, sequence`)
    : [];
  const byId = new Map<string, Holding['revisions']>();
  for (const r of [...seeds, ...daily]) {
    const list = byId.get(r.positionId) || [];
    list.push(r);
    byId.set(r.positionId, list);
  }
  const currencies = [...new Set(positions.map((p) => p.currency))];
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { baseCurrency: true, includeIndependentAssets: true },
  });
  const previousDay = new Date(+new Date(from) - 86400000).toISOString().slice(0, 10);
  const rates = await db.exchangeRate.findMany({
    where: {
      userId,
      currency: { in: currencies },
      baseCurrency: user.baseCurrency,
      date: { gte: new Date(from), lte: new Date(to) },
    },
  });
  const priorRates = await currentRates(db, userId, currencies, user.baseCurrency, previousDay);
  return {
    positions: positions.map((p) => ({
      ...p,
      included: p.included && (p.kind !== 'asset' || user.includeIndependentAssets),
      revisions: byId.get(p.id) || [],
    })),
    rates: [...priorRates, ...rates],
    base: user.baseCurrency,
  };
}
