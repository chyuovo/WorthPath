import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { history, overview, totals, trend } from '../src/calculation';
import { currentPositions, historyPage, trendData, currentRates } from '../src/queries';
import { today, toBusinessDate } from '../src/validation';
import { writeFileSync } from 'node:fs';

// Dedicated random users only; no existing user's rows are read or changed.
const phase = process.argv[2] || 'after';
const db = new PrismaClient({
  transactionOptions: { timeout: 120000, maxWait: 10000 },
  log: [{ emit: 'event', level: 'query' }],
});
let events: { query: string; params: string; duration: number }[] = [];
db.$on('query', (e) => events.push(e));
const results: unknown[] = [];
async function measure(name: string, work: () => Promise<unknown>) {
  console.log('Measuring ' + name);
  const times: number[] = [];
  let bytes = 0,
    queries = 0;
  for (let i = 0; i < 3; i++) {
    events = [];
    const start = performance.now();
    const value = await work();
    times.push(performance.now() - start);
    bytes = Buffer.byteLength(JSON.stringify(value));
    queries = events.length;
  }
  return { name, medianMs: Number(times.sort((a, b) => a - b)[1].toFixed(2)), bytes, queries };
}
async function plan(event: (typeof events)[number]) {
  const params = JSON.parse(event.params).map((p: unknown) =>
    typeof p === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:/.test(p) ? new Date(p) : p,
  );
  try {
    return await db.$queryRawUnsafe('EXPLAIN ANALYZE ' + event.query, ...params);
  } catch {
    return await db.$queryRawUnsafe('EXPLAIN ' + event.query, ...params);
  }
}
async function run() {
  for (const [accounts, count] of [
    [1, 10000],
    [1, 100000],
    [10, 10000],
  ]) {
    const user = await db.user.create({
      data: { username: 'wp_perf_' + randomUUID(), passwordHash: 'not-a-login-hash' },
    });
    try {
      const ids: string[] = [];
      const end = today(),
        start = new Date(+new Date(end) - 89 * 86400000).toISOString().slice(0, 10);
      for (let a = 0; a < accounts; a++) {
        const p = await db.position.create({
          data: {
            userId: user.id,
            kind: 'account',
            side: 'asset',
            name: 'benchmark',
            category: 'bank',
            currency: 'CNY',
            notes: '',
          },
        });
        ids.push(p.id);
        for (let offset = 0; offset < count; offset += 1000) {
          await db.revision.createMany({
            data: Array.from({ length: Math.min(1000, count - offset) }, (_, n) => ({
              positionId: p.id,
              amount: String(offset + n + 1),
              notes: '',
              reason: 'balance',
              effectiveDate: new Date(
                +toBusinessDate(start) + Math.floor(((offset + n) * 89) / (count - 1)) * 86400000,
              ),
            })),
          });
        }
      }
      const token = randomBytes(32).toString('hex');
      await db.session.create({
        data: {
          id: createHash('sha256').update(token).digest('hex'),
          userId: user.id,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      const httpBase = process.env.TEST_API_URL || 'http://127.0.0.1:33101/api';
      const http = async (path: string, base = httpBase) => {
        const response = await fetch(base + path, { headers: { Cookie: 'wp_session=' + token } });
        if (!response.ok) throw Error('HTTP benchmark status ' + response.status);
        return response.json();
      };
      const oldList = () =>
        db.$transaction(async (tx) => {
          const rows = await tx.position.findMany({
            where: { userId: user.id },
            include: {
              revisions: { orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }] },
              outgoing: true,
            },
          });
          return rows.map((p) => ({
            ...p,
            userId: undefined,
            amount: p.revisions.at(-1)?.amount.toString() || '0',
            history: history(p),
          }));
        });
      const oldOverview = () =>
        db.$transaction(
          async (tx) => {
            const rows = await tx.position.findMany({
              where: { userId: user.id },
              include: { revisions: true },
            });
            return overview(rows, [], 'CNY', end);
          },
          { timeout: 120000 },
        );
      const baseline = [
        await measure('old positions', oldList),
        await measure('old overview', oldOverview),
      ];
      const optimized = [
        await measure('new positions', () =>
          db.$transaction(async (tx) => {
            const rows = await currentPositions(tx, user.id, false);
            const rates = await currentRates(tx, user.id, ['CNY'], 'CNY', end);
            const amounts = new Map(totals(rows, rates, 'CNY', end).items.map((p) => [p.id, p]));
            return rows.map(({ revisions, userId, ...p }) => ({
              ...p,
              amount: revisions[0]?.amount.toString() || '0',
              converted: amounts.get(p.id)!.converted,
              rateDate: amounts.get(p.id)!.rateDate,
            }));
          }),
        ),
        await measure('new current overview', () =>
          db.$transaction(async (tx) =>
            totals(await currentPositions(tx, user.id, false), [], 'CNY', end),
          ),
        ),
        await measure('new history page', () =>
          db.$transaction((tx) => historyPage(tx, user.id, false, { limit: 50 })),
        ),
        await measure('new trend', () =>
          db.$transaction(
            async (tx) => {
              const data = await trendData(tx, user.id, false, start, end);
              return trend(data.positions, data.rates, 'CNY', start, end);
            },
            { timeout: 30000 },
          ),
        ),
      ];
      events = [];
      await db.position.findMany({
        where: { userId: user.id },
        include: {
          revisions: { orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }], take: 1 },
        },
      });
      const nestedSql = events.filter((e) => e.query.startsWith('SELECT')).map((e) => e.query);
      events = [];
      await currentPositions(db, user.id, false);
      const latestEvent = events.find((e) => e.query.includes('SELECT r.*'))!;
      const latestPlan = await plan(latestEvent);
      events = [];
      await historyPage(db, user.id, false, { limit: 50 });
      const pageEvent = events.find((e) => e.query.includes('AS beforeAmount'))!;
      const candidateEvents = events.filter(
        (e) =>
          e.query.includes('Revision') &&
          !e.query.includes('beforeAmount') &&
          e.query.startsWith('SELECT'),
      );
      const pagePlan = await plan(pageEvent);
      const candidatePlans = await Promise.all(candidateEvents.map(plan));
      const first = await historyPage(db, user.id, false, { limit: 50 });
      const second = await historyPage(db, user.id, false, { limit: 50, cursor: first.nextCursor });
      const deep = await historyPage(db, user.id, false, { limit: 50, to: start });
      if (
        first.items.some((a) => second.items.some((b) => a.id === b.id)) ||
        deep.items.some((r) => r.delta !== '1')
      )
        throw Error('Pagination boundary mismatch');
      const httpResults = [
        await measure('HTTP positions', () => http('/positions?kind=account')),
        await measure('HTTP overview', () => http('/overview')),
        await measure('HTTP history', () => http('/history?limit=50')),
        await measure('HTTP trend', () => http('/trend?from=' + start + '&to=' + end)),
      ];
      const oldHttpBase = process.env.BASELINE_API_URL;
      const baselineHttp = oldHttpBase
        ? [
            await measure('old HTTP positions', () => http('/positions', oldHttpBase)),
            await measure('old HTTP overview', () => http('/overview', oldHttpBase)),
          ]
        : [];
      results.push({
        accounts,
        revisionsPerAccount: count,
        baseline,
        optimized,
        httpResults,
        baselineHttp,
        nestedSql,
        latestPlan,
        pagePlan,
        candidatePlans,
      });
      writeFileSync(
        `../../docs/performance-${phase}.json`,
        JSON.stringify(
          { phase, node: process.version, results },
          (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
          2,
        ),
      );
      console.log(
        JSON.stringify({ phase, accounts, count, baseline, optimized, httpResults, baselineHttp }),
      );
    } finally {
      await db.user.delete({ where: { id: user.id } });
    }
  }
  writeFileSync(
    `../../docs/performance-${phase}.json`,
    JSON.stringify(
      { phase, node: process.version, results },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
}
run()
  .catch((e) => {
    console.error(
      'Benchmark failed: ' +
        (e.code || e.constructor.name) +
        ' ' +
        String(e.message)
          .replace(/mysql:\/\/[^\s]+/g, '[redacted]')
          .slice(-600),
    );
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
