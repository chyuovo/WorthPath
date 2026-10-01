import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { history, overview, totals, type Holding, type Rate } from '../src/calculation';
import { positionInput, date, amount, businessDate, toBusinessDate } from '../src/validation';
import { validateBackup } from '../src/backup';
import { RatesService } from '../src/rates';
import { Database } from '../src/database';
import { allowedOrigin } from '../src/auth';
test('development wildcard accepts HTTP origins while exact and production checks stay strict', () => {
  assert.equal(allowedOrigin('https://tunnel.example', '*'), true);
  assert.equal(allowedOrigin('http://example.test:8080', '*'), true);
  for (const origin of [
    undefined,
    'null',
    'file://host',
    'https://example.test/path',
    'https://name:secret@example.test',
  ])
    assert.equal(allowedOrigin(origin, '*'), false);
  assert.equal(allowedOrigin('https://tunnel.example', '*', true), false);
  assert.equal(allowedOrigin('https://tunnel.example', 'http://localhost:5173'), false);
  assert.equal(allowedOrigin('http://localhost:5173', 'http://localhost:5173'), true);
});
const rev = (amount: string, day: string) => ({
  id: randomUUID(),
  amount,
  effectiveDate: new Date(day),
  notes: '',
  reason: 'balance',
});
const p = (side = 'asset', currency = 'CNY'): Holding => ({
  id: randomUUID(),
  name: 'test',
  kind: 'account',
  side,
  currency,
  revisions: [rev('100.1', '2026-09-01')],
});
const rate = (value: string, day: string): Rate => ({
  currency: 'USD',
  baseCurrency: 'CNY',
  date: new Date(day),
  rate: value,
  source: 'manual',
});
test('decimal totals and liability sign', () => {
  const a = p(),
    b = p('liability');
  b.revisions[0].amount = '0.2';
  assert.equal(totals([a, b], [], 'CNY', '2026-09-01').net, '99.90');
});
test('minute history uses Hong Kong day boundaries and rejects invalid local times', () => {
  const a = p();
  a.revisions = [{ ...rev('8', '2026-09-01'), effectiveDate: toBusinessDate('2026-09-02T00:01') }];
  assert.equal(history(a)[0].time, '2026-09-02T00:01');
  assert.equal(totals([a], [], 'CNY', '2026-09-01').net, '0.00');
  assert.equal(totals([a], [], 'CNY', '2026-09-02').net, '8.00');
  assert.equal(businessDate.safeParse('2026-02-30T09:17').success, false);
  assert.equal(businessDate.safeParse('2026-09-01T25:17').success, false);
});
test('missing FX explicitly incomplete', () => {
  const v = totals([p('asset', 'USD')], [], 'CNY', '2026-09-01');
  assert.equal(v.complete, false);
  assert.deepEqual(v.missing, ['USD']);
  assert.equal(v.items[0].converted, null);
});
test('correction recalculates later delta', () => {
  const a = p();
  a.revisions = [rev('90.1', '2026-09-01'), rev('110.1', '2026-09-02')];
  assert.equal(history(a)[1].delta, '20');
  assert.equal(totals([a], [], 'CNY', '2026-09-02').net, '110.10');
});
test('multiple same-day balances preserve ordering and use last value in totals', () => {
  const a = p();
  a.revisions = [
    { ...rev('120.10', '2026-09-01'), sequence: 3 },
    { ...rev('100.10', '2026-09-01'), sequence: 1 },
    { ...rev('110.10', '2026-09-01'), sequence: 2 },
  ];
  assert.deepEqual(
    history(a).map((r) => r.after),
    ['100.1', '110.1', '120.1'],
  );
  assert.equal(history(a)[2].delta, '10');
  assert.equal(totals([a], [], 'CNY', '2026-09-01').net, '120.10');
  a.revisions[1].amount = '90.10';
  assert.equal(history(a)[1].delta, '20');
  assert.equal(totals([a], [], 'CNY', '2026-09-01').net, '120.10');
});
test('FX and actual changes separated', () => {
  const a = p('asset', 'USD');
  a.revisions = [rev('100', '2026-09-01'), rev('110', '2026-09-02')];
  const o = overview([a], [rate('7', '2026-09-01'), rate('8', '2026-09-02')], 'CNY', '2026-09-02');
  assert.equal(o.trend[1].fxChange, '100.00');
  assert.equal(o.trend[1].balanceChange, '80.00');
  assert.equal(o.net, '880.00');
});
test('large monetary strings stay exact', () => {
  const a = p();
  a.revisions = [rev('9999999999999999.98765432', '2026-09-01')];
  assert.equal(history(a)[0].after, '9999999999999999.98765432');
  assert.equal(totals([a], [], 'CNY', '2026-09-01').net, '9999999999999999.99');
});
test('reject invalid dates, negative values and credit card assets', () => {
  assert.equal(date.safeParse('2026-02-30').success, false);
  assert.equal(amount.safeParse('-1').success, false);
  assert.equal(
    positionInput.safeParse({
      name: 'Card',
      kind: 'account',
      side: 'asset',
      category: 'credit_card',
      currency: 'CNY',
      amount: '1',
      date: '2026-09-01',
    }).success,
    false,
  );
});
test('backup rejects auth data and broken relations', () => {
  const b = {
    format: 'worthpath',
    version: 1,
    exportedAt: new Date().toISOString(),
    baseCurrency: 'CNY',
    currencies: ['CNY'],
    positions: [],
    rates: [],
    links: [],
  };
  assert.doesNotThrow(() => validateBackup(b));
  assert.throws(() => validateBackup({ ...b, passwordHash: 'forbidden' }));
  assert.throws(() =>
    validateBackup({ ...b, links: [{ sourceId: randomUUID(), targetId: randomUUID() }] }),
  );
});
test('public FX uses a fixed request, preserves decimal tokens, manual rates and failure fallback', async () => {
  const writes: any[] = [];
  let manual = false;
  const db = {
    user: { findUniqueOrThrow: async () => ({ baseCurrency: 'CNY' }) },
    position: { findMany: async () => [{ currency: 'USD' }] },
    $transaction: async (fn: any) =>
      fn({
        user: { findUniqueOrThrow: async () => ({ baseCurrency: 'CNY' }) },
        position: { findMany: async () => [{ currency: 'USD' }] },
        exchangeRate: {
          findUnique: async () => (manual ? { source: 'manual' } : null),
          upsert: async (v: any) => writes.push(v.create),
        },
      }),
  } as unknown as Database;
  const fx = new RatesService(db),
    original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(
        String(url),
        'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,HKD,EUR,GBP,JPY,AUD,CAD,CHF,SGD',
      );
      return new Response(
        '[{"base":"USD","quote":"CNY","date":"2026-09-01","rate":7.987654321098}]',
      );
    };
    await fx.refresh('test-owner');
    assert.equal(writes[0].rate, '7.987654321098');
    manual = true;
    await fx.refresh('test-owner');
    assert.equal(writes.length, 1);
    globalThis.fetch = async () => {
      throw Error('offline');
    };
    await assert.rejects(() => fx.refresh('test-owner'), /原币金额和已有汇率已保留/);
    assert.equal(writes.length, 1);
    assert.equal(fx.status('test-owner').state, 'error');
  } finally {
    globalThis.fetch = original;
  }
});
