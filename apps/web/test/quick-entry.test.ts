import { repaymentFee } from '../src/repayment';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPaidForMonth,
  isBookedToday,
  quickAccountVisible,
  canQuickRepay,
  QuickJournal,
} from '../src/QuickJournal';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
test('repayment badges expire by business month without clearing stored data', () => {
  const p = { kind: 'account', side: 'liability', lastRepaymentMonth: '2026-10' };
  assert.equal(isPaidForMonth(p, '2026-10'), true);
  assert.equal(isPaidForMonth(p, '2026-11'), false);
  assert.equal(p.lastRepaymentMonth, '2026-10');
  assert.equal(isPaidForMonth({ ...p, kind: 'debt' }, '2026-10'), false);
});
test('quick repayment only applies to active liability accounts with an outstanding balance', () => {
  const p = { kind: 'account', side: 'liability', amount: '200.00000001', archived: false };
  assert.equal(canQuickRepay(p), true);
  for (const change of [
    { amount: '-5' },
    { amount: '0.00000000' },
    { archived: true },
    { kind: 'debt' },
    { side: 'asset' },
  ])
    assert.equal(canQuickRepay({ ...p, ...change }), false);
});
test('session journal displays exact balances and distinguishes saved versus undone entries', () => {
  const entry = {
    key: 'one',
    kind: 'balance' as const,
    id: 'test',
    positionId: 'account',
    title: '测试',
    currency: 'CNY',
    before: '100',
    after: '125.87654321',
    date: '2026-10-04T12:00',
  };
  const html = renderToStaticMarkup(
    createElement(QuickJournal, { entries: [entry], busy: false, undo: () => {} }),
  );
  assert.match(html, /125\.87654321/);
  assert.match(html, /撤回/);
  const undone = renderToStaticMarkup(
    createElement(QuickJournal, {
      entries: [{ ...entry, undone: true }],
      busy: false,
      undo: () => {},
    }),
  );
  assert.match(undone, /已撤回/);
  assert.doesNotMatch(undone, /<button/);
});

test('daily badges expire and filters combine month and day without mutating markers', () => {
  const p = {
    id: 'test',
    kind: 'account',
    side: 'liability',
    lastRepaymentMonth: '2026-10',
    lastBookedDate: '2026-10-04',
    archived: false,
  } as any;
  assert.equal(isBookedToday(p, '2026-10-04'), true);
  assert.equal(isBookedToday(p, '2026-10-05'), false);
  assert.equal(quickAccountVisible(p, '2026-10', '2026-10-05', true, false), false);
  assert.equal(quickAccountVisible(p, '2026-11', '2026-10-04', true, true), false);
  assert.equal(quickAccountVisible(p, '2026-11', '2026-10-05', true, true), true);
  assert.equal(
    quickAccountVisible({ ...p, side: 'asset' }, '2026-11', '2026-10-05', true, false),
    false,
  );
  assert.equal(p.lastBookedDate, '2026-10-04');
});

test('repayment discount uses opposite fee sign without decimal precision loss', () => {
  assert.equal(repaymentFee('5.87654321'), '-5.87654321');
  assert.equal(repaymentFee('-1.86420975'), '1.86420975');
  assert.equal(repaymentFee('-0.00000000'), '0');
  assert.equal(repaymentFee('0'), '0');
  assert.throws(() => repaymentFee('1e3'));
});
