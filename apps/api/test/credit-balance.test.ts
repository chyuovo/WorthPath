import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('liability account credit balances survive revisions, replay, calendar, privacy and ZIP restore', async () => {
  const db = new PrismaClient(),
    ids: string[] = [];
  const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
  async function user() {
    const u = await db.user.create({
      data: { username: 'wp_credit_' + randomUUID(), passwordHash: 'unused' },
    });
    ids.push(u.id);
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: createHash('sha256').update(token).digest('hex'),
        userId: u.id,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { id: u.id, cookie: 'wp_session=' + token };
  }
  async function call(path: string, cookie: string, method = 'GET', body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  }
  try {
    const a = await user(),
      b = await user();
    const initial = {
      name: 'Card',
      kind: 'account',
      side: 'liability',
      category: 'credit_card',
      currency: 'CNY',
      amount: '100',
      date: '2026-09-01T10:00',
    };
    const create = await call('/positions', a.cookie, 'POST', initial);
    assert.equal(create.status, 201);
    const id = create.data.id;
    const balance = async (amount: string, date = '2026-09-02T10:00') =>
      call('/positions/' + id + '/revisions', a.cookie, 'POST', {
        amount,
        date,
        reason: 'balance',
      });
    const credit = await balance('-25');
    assert.equal(credit.status, 201);
    assert.equal((await call('/positions/' + id, a.cookie)).data.amount, '-25');
    let totals = (await call('/overview', a.cookie)).data;
    assert.equal(totals.assets, '25.00');
    assert.equal(totals.liabilities, '0.00');
    assert.equal(totals.net, '25.00');
    let day = (await call('/calendar/day?date=2026-09-02', a.cookie)).data;
    assert.equal(day.items[0].amount, '125');
    assert.equal(day.items[0].direction, 'income');
    assert.equal(
      (
        await call('/positions/' + id + '/revisions/' + credit.data.id, b.cookie, 'PUT', {
          amount: '-30',
          date: '2026-09-02T10:00',
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('/positions/' + id + '/revisions/' + credit.data.id, a.cookie, 'PUT', {
          amount: '-30',
          date: '2026-09-02T10:00',
        })
      ).status,
      200,
    );
    assert.equal((await call('/overview', a.cookie)).data.assets, '30.00');
    assert.equal(
      (await call('/calendar/day?date=2026-09-02', a.cookie)).data.items[0].amount,
      '130',
    );
    assert.equal(
      (await call('/positions/' + id + '/revisions/' + credit.data.id, a.cookie, 'DELETE')).status,
      200,
    );
    assert.equal((await call('/overview', a.cookie)).data.liabilities, '100.00');
    await balance('-20');
    await balance('10', '2026-09-03T10:00');
    day = (await call('/calendar/day?date=2026-09-03', a.cookie)).data;
    assert.equal(day.items[0].direction, 'expense');
    assert.equal(day.items[0].amount, '30');
    const history = (await call('/positions/' + id + '/history', a.cookie)).data.items;
    await call('/positions/' + id + '/revisions/' + history[0].id, a.cookie, 'DELETE');
    assert.equal((await call('/positions/' + id, a.cookie)).data.amount, '-20');
    assert.equal(
      (
        await call('/positions', a.cookie, 'POST', {
          ...initial,
          name: 'Initial credit',
          amount: '-5.01',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call('/positions', a.cookie, 'POST', {
          ...initial,
          name: 'Debt',
          kind: 'debt',
          category: 'personal',
          amount: '10',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call('/positions', a.cookie, 'POST', {
          ...initial,
          name: 'Invalid debt',
          kind: 'debt',
          category: 'personal',
          amount: '-1',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/positions', a.cookie, 'POST', {
          ...initial,
          name: 'Invalid asset',
          kind: 'asset',
          side: 'asset',
          category: 'other',
          amount: '-1',
        })
      ).status,
      400,
    );
    totals = (await call('/overview', a.cookie)).data;
    assert.equal(totals.assets, '25.01');
    assert.equal(totals.liabilities, '10.00');
    assert.equal(totals.net, '15.01');
    const trend = (await call('/trend?from=2026-09-01&to=2026-09-03', a.cookie)).data.items;
    assert.equal(trend[0].assets, '5.01');
    assert.equal(trend[0].liabilities, '110.00');
    assert.equal(trend[1].assets, '25.01');
    assert.equal(trend[1].liabilities, '10.00');
    const zip = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.equal(zip.status, 200);
    const backup: any = await readBackupZip(Buffer.from(await zip.arrayBuffer()));
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    const restored = (await call('/overview', b.cookie)).data;
    assert.equal(restored.assets, '25.01');
    assert.equal(restored.liabilities, '10.00');
    assert.equal(restored.net, '15.01');
    assert.equal(
      (await call('/calendar/day?date=2026-09-02', b.cookie)).data.items[0].amount,
      '120',
    );
    assert.equal(
      (
        await call('/positions/' + id, a.cookie, 'PATCH', {
          name: 'Card',
          category: 'credit_card',
          hidden: true,
        })
      ).status,
      200,
    );
    assert.equal((await call('/positions/' + id, a.cookie)).status, 404);
    assert.equal((await call('/overview', a.cookie)).data.assets, '5.01');
  } finally {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
