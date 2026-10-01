import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { history, overview, totals, type Holding, type Rate } from '../src/calculation';
import { positionInput, date, amount } from '../src/validation';
import { validateBackup } from '../src/backup';
import { RatesService } from '../src/rates';
import { Database } from '../src/database';
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
