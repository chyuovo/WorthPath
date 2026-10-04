import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestTrendIndex, trendPath, NetWorthChart } from '../src/NetWorthChart';
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
