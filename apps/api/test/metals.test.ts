import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetalsService, metalValue } from '../src/metals';
import { totals, trend, type Holding } from '../src/calculation';
import { today } from '../src/validation';
test('excluded holdings do not require FX or contribute to totals, attribution or earliest trend date', () => {
  const holding = (id: string, currency: string, included: boolean, day: string): Holding => ({
    id,
    name: id,
    kind: 'asset',
    side: 'asset',
    currency,
    included,
    revisions: [
      { id: id + 'r', amount: '100', effectiveDate: new Date(day), notes: '', reason: 'initial' },
    ],
  });
  const ps = [
    holding('excluded', 'USD', false, '2026-01-01'),
    holding('visible', 'CNY', true, '2026-10-01'),
  ];
  const result = totals(ps, [], 'CNY', '2026-10-03');
  assert.equal(result.net, '100.00');
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  const points = trend(ps, [], 'CNY', '2026-09-30', '2026-10-03');
  assert.equal(points[0].date, '2026-10-01');
  assert.equal(points[0].balanceChange, '100.00');
  assert.ok(points.every((p) => p.complete && p.fxChange === '0.00'));
});
test('public metal update preserves decimal values and manual quotes, skips cleared positions and keeps old prices on failure', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  const writes: any[] = [];
  var cleared = false;
  const db: any = {
    position: { findMany: async () => [{ id: 'p', currency: 'CNY', metalType: 'gold' }] },
    serial: async (fn: any) =>
      fn({
        $queryRaw: async () => [],
        position: {
          findMany: async () =>
            cleared ? [] : [{ id: 'p', currency: 'CNY', metalType: 'gold', autoValuation: false }],
        },
        metalPrice: {
          findUnique: async () => ({ source: 'manual' }),
          upsert: async (v: any) => writes.push(v),
        },
      }),
  };
  try {
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(
        String(url).includes('frankfurter')
          ? JSON.stringify([{ base: 'USD', quote: 'CNY', date: today(), rate: 6.700400864209 }])
          : JSON.stringify({
              currency: 'USD',
              symbol: String(url).endsWith('XAU') ? 'XAU' : 'XAG',
              price: 4141.799805864209,
              updatedAt: new Date().toISOString(),
            }),
      );
    }) as typeof fetch;
    const service = new MetalsService(db);
    await service.refresh('user');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((u) => !u.includes('user')));
    assert.equal(writes.length, 0);
    cleared = true;
    await service.refresh('user');
    assert.equal(writes.length, 0);
    globalThis.fetch = (async () => {
      throw Error('offline');
    }) as typeof fetch;
    await assert.rejects(service.refresh('user'));
    assert.equal(service.status('user').state, 'error');
    assert.equal(writes.length, 0);
    assert.equal(metalValue('10.86420978', '0.999', '700.864209789012'), '7606.72146664');
  } finally {
    globalThis.fetch = original;
  }
});
