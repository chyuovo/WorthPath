import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestTrendIndex, trendPath, trendDomain, NetWorthChart } from '../src/NetWorthChart';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const rows = [
  {
    date: '2026-09-01',
    assets: '100.86420975',
    liabilities: '20',
    net: '80.86420975',
    complete: true,
    missing: [],
  },
  {
    date: '2026-09-02',
    assets: '0',
    liabilities: '0',
    net: '0',
    complete: false,
    missing: ['USD'],
  },
  { date: '2026-09-10', assets: '120', liabilities: '20', net: '100', complete: true, missing: [] },
];
test('hover dates use time distance across uneven dates and expose missing dates', () => {
  assert.equal(nearestTrendIndex(rows, Date.parse('2026-09-02T00:00:00Z')), 1);
  assert.equal(nearestTrendIndex(rows, Date.parse('2026-09-09T00:00:00Z')), 2);
  assert.equal(nearestTrendIndex(rows, Date.parse('2026-08-01T00:00:00Z')), 0);
});
test('trend paths keep a gap for incomplete dates rather than connecting misleading totals', () => {
  const path = trendPath(
    rows,
    'net',
    (d) => Number(d.slice(-2)),
    (v) => Number(v),
  );
  assert.equal(path, 'M1,80.86420975  M10,100');
});
test('trend legend offers three independent toggles and exact monetary data', () => {
  const html = renderToStaticMarkup(createElement(NetWorthChart, { rows, base: 'CNY' }));
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 3);
  assert.equal((html.match(/data-series=/g) || []).length, 3);
  assert.match(html, /80\.86420975/);
  assert.match(html, /tabindex="0"/);
});

test('visible series control the vertical domain without forcing zero', () => {
  const values = [
    { ...rows[0], assets: '1000', net: '990', liabilities: '10' },
    { ...rows[2], assets: '1010', net: '1000', liabilities: '10' },
  ];
  const all = trendDomain(values, ['assets', 'net', 'liabilities']);
  const hidden = trendDomain(values, ['assets', 'net']);
  assert.ok(all.min < 10);
  assert.ok(hidden.min > 980);
  assert.ok(hidden.max > 1010);
  assert.ok(trendDomain(values, ['liabilities']).max > 10);
  assert.ok(trendDomain([{ ...values[0], net: '-10' }], ['net']).min < -10);
  assert.deepEqual(trendDomain(values, []), { min: 0, max: 1 });
});
test('selected date bounds remain visible and a single date plots one point per series', () => {
  const html = renderToStaticMarkup(
    createElement(NetWorthChart, {
      rows: [rows[0]],
      base: 'CNY',
      from: '2026-08-30',
      to: '2026-09-05',
    }),
  );
  assert.match(html, /2026-08-30/);
  assert.match(html, /2026-09-05/);
  assert.equal((html.match(/<circle/g) || []).length, 3);
});
