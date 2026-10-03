import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cashflowDelta, calendarMonth, CalendarController } from '../src/calendar';
import { executeMovement } from '../src/transfers';
import { transferInput, positionInput, revisionInput } from '../src/validation';
import { scheduleInput, occurrenceId, nextOccurrence, SchedulesController } from '../src/schedules';
import { trend, totals, type Holding } from '../src/calculation';
import { positionAmount, accountInputAmount, money, type Position } from '../../web/src/api';
const now = new Date(Date.now() - 60000);
const date = new Date(+now + 8 * 3600000).toISOString().slice(0, 16);
function fixture(
  targetKind = 'account',
  targetSide = 'asset',
  sourceBalance = '10',
  targetBalance = '0',
) {
  const owner = randomUUID(),
    sourceId = randomUUID(),
    targetId = randomUUID();
  const accounts = [
    { id: sourceId, kind: 'account', side: 'asset', currency: 'CNY', userId: owner },
    { id: targetId, kind: targetKind, side: targetSide, currency: 'CNY', userId: owner },
  ];
  const balances = new Map([
      [sourceId, sourceBalance],
      [targetId, targetBalance],
    ]),
    entries: any[] = [],
    transfers: any[] = [];
  const tx: any = {
    $queryRaw: async (query: any) =>
      query.sql.includes('SELECT r.*')
        ? accounts.map((p) => ({
            positionId: p.id,
            amount: balances.get(p.id),
            effectiveDate: new Date('2026-09-01'),
            id: randomUUID(),
          }))
        : [],
    position: { findMany: async () => accounts },
    revision: {
      create: async ({ data }: any) => {
        const row = { id: randomUUID(), ...data };
        entries.push(row);
        balances.set(data.positionId, data.amount);
        return row;
      },
    },
    transfer: {
      findFirst: async ({ where }: any) => transfers.find((v) => v.id === where.id),
      create: async ({ data }: any) => {
        transfers.push(data);
        return data;
      },
    },
    positionLink: { upsert: async () => ({}) },
  };
  const request = transferInput.parse({
    requestId: randomUUID(),
    sourceId,
    targetId,
    amount: '25',
    received: '25',
    fee: '1',
    date,
  });
  return {
    tx,
    r: { userId: owner, revealed: false },
    request,
    balances,
    entries,
    transfers,
    sourceId,
    targetId,
  };
}
test('overdrafts preserve exact paired balances and idempotency', async () => {
  const f = fixture();
  await executeMovement(f.tx, f.r, f.request);
  assert.equal(f.balances.get(f.sourceId), '-16');
  assert.equal(f.balances.get(f.targetId), '25');
  assert.equal(f.entries.length, 2);
  await executeMovement(f.tx, f.r, f.request);
  assert.equal(f.entries.length, 2);
  await assert.rejects(() => executeMovement(f.tx, f.r, { ...f.request, amount: '26' }));
  const p: Holding = {
    id: f.sourceId,
    name: '',
    kind: 'account',
    side: 'asset',
    currency: 'CNY',
    revisions: [{ id: '', amount: '-16', effectiveDate: now, reason: 'balance', notes: '' }],
  };
  assert.equal(totals([p], [], 'CNY', date.slice(0, 10)).net, '-16.00');
});
test('transfer into an overdrawn account is allowed; debt overpayment still fails before writing', async () => {
  const f = fixture('account', 'asset', '10', '-100');
  await executeMovement(f.tx, f.r, f.request);
  assert.equal(f.balances.get(f.targetId), '-75');
  const debt = fixture('debt', 'liability', '0', '10');
  await assert.rejects(() =>
    executeMovement(debt.tx, debt.r, { ...debt.request, operation: 'repay' }),
  );
  assert.equal(debt.entries.length, 0);
  await executeMovement(debt.tx, debt.r, {
    ...debt.request,
    operation: 'repay',
    amount: '10',
    received: '10',
  });
  assert.equal(debt.balances.get(debt.sourceId), '-11');
  assert.equal(debt.balances.get(debt.targetId), '0');
});
test('negative balances are confined to accounts; group names and debt principal remain validated', () => {
  const data = {
    name: 'test',
    category: 'bank',
    kind: 'account',
    side: 'asset',
    amount: '-12.24681357',
    currency: 'CNY',
    date,
    groupName: '日常',
  };
  assert.equal(positionInput.parse(data).groupName, '日常');
  assert.equal(positionInput.safeParse({ ...data, kind: 'debt' }).success, false);
  assert.equal(positionInput.safeParse({ ...data, side: 'liability' }).success, true);
  assert.equal(positionInput.safeParse({ ...data, groupName: 'a'.repeat(61) }).success, false);
  assert.equal(revisionInput.parse({ amount: '-0.00000001', date }).amount, '-0.00000001');
  assert.equal(transferInput.safeParse({ ...fixture().request, amount: '-1' }).success, false);
});
test('trend starts at the first balance, retains valid zero days and handles an empty portfolio', () => {
  const p: Holding = {
    id: randomUUID(),
    name: '',
    kind: 'account',
    side: 'asset',
    currency: 'CNY',
    revisions: [
      {
        id: '',
        amount: '0',
        effectiveDate: new Date('2026-09-15T02:00:00Z'),
        notes: '',
        reason: 'initial',
      },
    ],
  };
  const rows = trend([p], [], 'CNY', '2026-09-01', '2026-09-17');
  assert.deepEqual(
    rows.map((r) => r.date),
    ['2026-09-15', '2026-09-16', '2026-09-17'],
  );
  assert.equal(rows[0].net, '0.00');
  assert.deepEqual(trend([], [], 'CNY', '2026-09-01', '2026-09-17'), []);
  assert.deepEqual(trend([p], [], 'CNY', '2026-09-01', '2026-09-14'), []);
});
test('debt signs and currency symbols preserve the original decimal strings', () => {
  const p = { kind: 'debt', side: 'liability', amount: '9999999999999999.24681357' } as Position;
  assert.equal(positionAmount(p), '-9999999999999999.24681357');
  assert.equal(money(positionAmount(p), 'HKD'), 'HK$ -9,999,999,999,999,999.24681357');
  assert.equal(positionAmount({ ...p, amount: '0.00000000' }), '0.00000000');
  assert.equal(positionAmount({ ...p, side: 'asset' }), p.amount);
});
test('schedule validation rejects malformed times and creates stable occurrence identifiers', () => {
  const data = {
    name: '租金',
    operation: 'expense',
    sourceId: randomUUID(),
    amount: '100',
    nextAt: '2026-11-01T09:00',
    intervalDays: 30,
  };
  assert.equal(scheduleInput.safeParse(data).success, true);
  assert.equal(scheduleInput.safeParse({ ...data, nextAt: '2026-02-30T09:00' }).success, false);
  assert.equal(scheduleInput.safeParse({ ...data, operation: 'transfer' }).success, false);
  assert.equal(scheduleInput.safeParse({ ...data, intervalDays: -1 }).success, false);
  assert.equal(occurrenceId('plan', now), occurrenceId('plan', now));
  assert.notEqual(occurrenceId('plan', now), occurrenceId('plan', nextOccurrence(now, 1)));
  assert.equal(+nextOccurrence(now, 30) - +now, 30 * 86400000);
});
test('due expense runs once, updates balance exactly and advances a recurring plan only after success', async () => {
  const owner = randomUUID(),
    sourceId = randomUUID();
  const plan: any = {
    id: randomUUID(),
    userId: owner,
    name: 'Rent',
    operation: 'expense',
    sourceId,
    targetId: null,
    amount: '12.00000001',
    received: '0',
    nextAt: new Date(Date.now() - 3600000),
    intervalDays: 0,
    enabled: true,
    notes: '',
  };
  const entries: any[] = [];
  let balance = '10';
  const tx: any = {
    $queryRaw: async () => [],
    position: {
      findMany: async () => [{ id: sourceId }],
      findFirst: async () => ({ id: sourceId, revisions: [{ amount: balance }] }),
    },
    schedule: {
      findMany: async () => (plan.enabled ? [{ ...plan }] : []),
      findFirst: async () => (plan.enabled ? { ...plan } : null),
      update: async ({ data }: any) => Object.assign(plan, data),
    },
    revision: {
      create: async ({ data }: any) => {
        entries.push(data);
        balance = data.amount;
        return data;
      },
    },
  };
  const db: any = { ...tx, serial: async (work: any) => work(tx) };
  const c = new SchedulesController(db),
    r: any = { userId: owner, revealed: false };
  assert.equal((await c.run(r)).executed, 1);
  assert.equal(balance, '-2.00000001');
  assert.equal(plan.enabled, false);
  assert.equal(plan.completed, true);
  assert.equal((await c.run(r)).executed, 0);
  assert.equal(entries.length, 1);
  const before = new Date(Date.now() - 3600000);
  Object.assign(plan, { enabled: true, nextAt: before, intervalDays: 30 });
  assert.equal((await c.run(r)).executed, 1);
  assert.equal(+plan.nextAt, +before + 30 * 86400000);
  const next = plan.nextAt;
  tx.position.findFirst = async () => null;
  plan.nextAt = before;
  const result = await c.run(r);
  assert.equal(result.executed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(+plan.nextAt, +before);
  assert.equal(entries.length, 2);
});

test('calendar excludes transfers, loans and initial balances and reverses liability changes', () => {
  for (const reason of [
    'transfer_out',
    'transfer_in',
    'loan_repay',
    'loan_collect',
    'loan_borrow',
    'loan_lend',
    'initial',
    'valuation',
  ])
    assert.equal(cashflowDelta('asset', reason, '100', '50').toFixed(), '0');
  assert.equal(cashflowDelta('asset', 'balance', '100', '150').toFixed(), '50');
  assert.equal(cashflowDelta('asset', 'scheduled_expense', '100', '50').toFixed(), '-50');
  assert.equal(cashflowDelta('liability', 'balance', '100', '150').toFixed(), '-50');
  assert.equal(calendarMonth('2024-02').days, 29);
  assert.throws(() => calendarMonth('2026-13'));
});
test('calendar replays only the range, preserves fractional totals, and hides incomplete FX totals', async () => {
  const accounts = [
    { id: 'cash', side: 'asset', name: '现金', currency: 'CNY' },
    { id: 'usd', side: 'asset', name: '外币', currency: 'USD' },
  ];
  const rows = [
    {
      id: '1',
      positionId: 'cash',
      amount: '10',
      effectiveDate: new Date('2026-09-02T01:00:00Z'),
      reason: 'correction',
      sequence: 1,
    },
    {
      id: '2',
      positionId: 'cash',
      amount: '10.004',
      effectiveDate: new Date('2026-09-02T02:00:00Z'),
      reason: 'balance',
      sequence: 2,
    },
    {
      id: '3',
      positionId: 'cash',
      amount: '10.008',
      effectiveDate: new Date('2026-09-02T03:00:00Z'),
      reason: 'balance',
      sequence: 3,
    },
    {
      id: '4',
      positionId: 'cash',
      amount: '8.008',
      effectiveDate: new Date('2026-09-02T04:00:00Z'),
      reason: 'scheduled_expense',
      sequence: 4,
    },
    {
      id: '5',
      positionId: 'usd',
      amount: '10',
      effectiveDate: new Date('2026-09-03T01:00:00Z'),
      reason: 'initial',
      sequence: 1,
    },
    {
      id: '6',
      positionId: 'usd',
      amount: '11',
      effectiveDate: new Date('2026-09-03T02:00:00Z'),
      reason: 'balance',
      sequence: 2,
    },
  ];
  const tx: any = {
    position: {
      findMany: async (input: any) => {
        assert.equal(input.where.userId, 'owner');
        assert.equal(input.where.hidden, false);
        return accounts;
      },
    },
    revision: {
      findMany: async (input: any) => {
        assert.equal(+input.where.effectiveDate.gte, +new Date('2026-08-31T16:00:00Z'));
        return rows;
      },
    },
    user: { findUniqueOrThrow: async () => ({ baseCurrency: 'CNY' }) },
    exchangeRate: { findMany: async () => [], findFirst: async () => null },
    $queryRaw: async () => [],
  };
  const db: any = { $transaction: async (work: any) => work(tx) };
  const c = new CalendarController(db),
    r: any = { userId: 'owner', revealed: false };
  const month = await c.month(r, '2026-09');
  assert.equal(month.items[1].income, '0.01');
  assert.equal(month.items[1].expense, '2.00');
  assert.equal(month.items[2].complete, false);
  assert.equal(month.items.length, 30);
});

test('liability account credit balances invert display and input without losing decimal precision', () => {
  const card = {
    kind: 'account',
    side: 'liability',
    amount: '-9999999999999999.24681357',
  } as Position;
  assert.equal(positionAmount(card), '9999999999999999.24681357');
  assert.equal(positionAmount(card, '12.24681357'), '-12.24681357');
  assert.equal(positionAmount(card, '-0.00000000'), '0.00000000');
  assert.equal(accountInputAmount(card, '12.24681357'), '-12.24681357');
  assert.equal(accountInputAmount(card, '-12.24681357'), '12.24681357');
  assert.equal(accountInputAmount({ ...card, kind: 'debt' }, '12.24681357'), '12.24681357');
});
test('credit balances count as assets across zero, retain FX attribution and do not offset other liabilities', () => {
  const card: Holding = {
    id: randomUUID(),
    name: 'Card',
    kind: 'account',
    side: 'liability',
    currency: 'USD',
    revisions: [
      {
        id: 'a',
        amount: '100',
        effectiveDate: new Date('2026-09-01'),
        reason: 'initial',
        notes: '',
      },
      {
        id: 'b',
        amount: '-25',
        effectiveDate: new Date('2026-09-02'),
        reason: 'balance',
        notes: '',
      },
    ],
  };
  const rates = [
    {
      currency: 'USD',
      baseCurrency: 'CNY',
      date: new Date('2026-09-01'),
      rate: '7',
      source: 'manual',
    },
    {
      currency: 'USD',
      baseCurrency: 'CNY',
      date: new Date('2026-09-02'),
      rate: '8',
      source: 'manual',
    },
  ];
  const owing = totals([card], rates, 'CNY', '2026-09-01');
  assert.equal(owing.assets, '0.00');
  assert.equal(owing.liabilities, '700.00');
  assert.equal(owing.net, '-700.00');
  const credit = totals([card], rates, 'CNY', '2026-09-02');
  assert.equal(credit.assets, '200.00');
  assert.equal(credit.liabilities, '0.00');
  assert.equal(credit.net, '200.00');
  const rows = trend([card], rates, 'CNY', '2026-09-01', '2026-09-02');
  assert.equal(rows[1].fxChange, '-100.00');
  assert.equal(rows[1].balanceChange, '1000.00');
  const debt = {
    ...card,
    id: randomUUID(),
    kind: 'debt',
    currency: 'CNY',
    revisions: [{ ...card.revisions[0], amount: '20' }],
  };
  const mixed = totals([card, debt], rates, 'CNY', '2026-09-02');
  assert.equal(mixed.assets, '200.00');
  assert.equal(mixed.liabilities, '20.00');
  assert.equal(mixed.net, '180.00');
  assert.equal(cashflowDelta('liability', 'balance', '100', '-25').toFixed(), '125');
  assert.equal(cashflowDelta('liability', 'balance', '-25', '10').toFixed(), '-35');
});

test('group order keeps visible subsets stable and distinguishes unnamed and named groups', async () => {
  const { orderedGroups, mergeGroupOrder } = await import('../../web/src/group-order');
  assert.deepEqual(
    orderedGroups(['日常', '', '未分组', '理财', '日常'], ['理财', '', '日常', '已隐藏']),
    ['理财', '', '日常', '未分组'],
  );
  assert.deepEqual(orderedGroups(['日常'], ['理财', '', '日常']), ['日常']);
  assert.deepEqual(mergeGroupOrder(['日常', '理财'], ['理财', '隐藏']), ['日常', '理财', '隐藏']);
});
