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

test('actual record badges expire and filters ignore obsolete manual markers', () => {
  const p = {
    id: 'test',
    kind: 'account',
    side: 'liability',
    lastRepaymentMonth: '2026-10',
    activityDate: '2026-10-04',
    lastBookedDate: '2026-10-05',
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
  assert.equal(p.lastBookedDate, '2026-10-05');
  assert.equal(isBookedToday({ ...p, activityDate: null }, '2026-10-05'), false);
  assert.equal(isBookedToday({ ...p, kind: 'asset' }, '2026-10-04'), false);
});

test('repayment discount uses opposite fee sign without decimal precision loss', () => {
  assert.equal(repaymentFee('5.87654321'), '-5.87654321');
  assert.equal(repaymentFee('-1.86420975'), '1.86420975');
  assert.equal(repaymentFee('-0.00000000'), '0');
  assert.equal(repaymentFee('0'), '0');
  assert.throws(() => repaymentFee('1e3'));
});

import {
  accountPages,
  overviewPages,
  settingsPages,
  navigationGroup,
  availablePages,
  navigationDestination,
} from '../src/navigation';
test('navigation retains access to visible children and restricts admin to administrators', () => {
  for (const page of accountPages) assert.equal(navigationGroup(page), 'account');
  for (const page of overviewPages) assert.equal(navigationGroup(page), 'overview');
  for (const page of settingsPages) assert.equal(navigationGroup(page), 'settings');
  assert.equal(navigationDestination('account', ['account']), 'asset');
  assert.equal(navigationDestination('account', ['account', 'asset', 'debt']), undefined);
  assert.equal(navigationDestination('overview', ['overview']), 'history');
  assert.equal(navigationDestination('settings', ['settings', 'schedules'], 'user'), 'settings');
  assert.deepEqual(availablePages(settingsPages, [], 'user'), ['settings', 'schedules']);
  assert.deepEqual(availablePages(settingsPages, [], 'admin'), ['settings', 'schedules', 'admin']);
});
