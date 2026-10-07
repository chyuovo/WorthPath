import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { today } from '../src/validation';
import { readBackupZip } from '../src/zip';
import { fixtureFetch } from './backup-fixture';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
test('quick entries undo paired repayment and balance, persist monthly marks, protect privacy and survive ZIP restore', async () => {
  const db = new PrismaClient(),
    users: string[] = [];
  async function user() {
    const u = await db.user.create({
      data: { username: 'quick_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    users.push(u.id);
    const token = randomBytes(32).toString('hex'),
      sid = createHash('sha256').update(token).digest('hex');
    await db.session.create({
      data: { id: sid, userId: u.id, expiresAt: new Date(Date.now() + 3600000) },
    });
    return { id: u.id, cookie: 'wp_session=' + token, sid };
  }
  async function call(u: any, path: string, method = 'GET', data?: unknown) {
    const r = await fixtureFetch(base + path, {
      method,
      headers: {
        Cookie: u.cookie,
        Origin: origin,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      data: r.headers.get('content-type')?.includes('application/zip')
        ? await readBackupZip(Buffer.from(await r.arrayBuffer()))
        : await r.json(),
    };
  }
  try {
    const a = await user(),
      b = await user();
    const create = async (
      name: string,
      kind: string,
      side: string,
      category: string,
      amount: string,
      hidden = false,
    ) => {
      const r = await call(a, '/positions', 'POST', {
        name,
        kind,
        side,
        category,
        amount,
        hidden,
        currency: 'CNY',
        date: '2026-09-01T10:00',
      });
      assert.equal(r.status, 201);
      return r.data.id as string;
    };
    const cash = await create('付款账户', 'account', 'asset', 'bank', '1000');
    const card = await create('欠款账户', 'account', 'liability', 'credit_card', '200');
    for (const category of ['commemorative_coin', 'commemorative_note']) {
      const id = await create(category, 'asset', 'asset', category, '50');
      assert.equal((await call(a, '/positions/' + id)).data.category, category);
    }

    const coin = (await db.position.findFirst({
      where: { userId: a.id, category: 'commemorative_coin' },
    }))!;
    const inclusionPath = '/positions/' + coin.id + '/inclusion';
    assert.equal(
      (await call(b, inclusionPath, 'PATCH', { included: false, expectedIncluded: true })).status,
      404,
    );
    assert.equal(
      (
        await call(a, inclusionPath, 'PATCH', {
          included: false,
          expectedIncluded: true,
          expectedUpdatedAt: coin.updatedAt.toISOString(),
        })
      ).status,
      200,
    );
    assert.equal((await call(a, '/positions/' + coin.id)).data.included, false);
    assert.equal(
      (await call(a, inclusionPath, 'PATCH', { included: true, expectedIncluded: true })).status,
      409,
    );
    assert.equal(
      (
        await call(a, '/positions/' + cash + '/inclusion', 'PATCH', {
          included: false,
          expectedIncluded: true,
        })
      ).status,
      400,
    );
    const day = today();
    // The obsolete marker remains in ZIP v9, but cannot be written through the retired route.
    await db.position.update({ where: { id: cash }, data: { lastBookedDate: day } });
    assert.equal(
      (
        await call(a, '/positions/' + cash + '/booked-mark', 'PATCH', {
          date: day,
          expectedDate: null,
        })
      ).status,
      404,
    );
    assert.equal(
      (await call(a, '/positions?kind=account')).data.find((p: any) => p.id === cash).activityDate,
      null,
    );
    const revision = await call(a, '/positions/' + cash + '/revisions', 'POST', {
      amount: '1050.87654321',
      date: '2026-09-02T10:00',
    });
    assert.equal(revision.status, 201);
    assert.equal(
      (await call(a, '/positions/' + cash + '/revisions/' + revision.data.id, 'DELETE')).status,
      200,
    );
    assert.equal((await call(a, '/positions/' + cash)).data.amount, '1000');
    const payment = await call(a, '/transfers', 'POST', {
      sourceId: cash,
      targetId: card,
      amount: '30',
      received: '30',
      fee: '0',
      date: '2026-09-03T10:00',
      requestId: randomUUID(),
    });
    assert.equal(payment.status, 201);
    assert.equal((await call(a, '/positions/' + cash)).data.amount, '970');
    assert.equal((await call(a, '/positions/' + card)).data.amount, '170');
    assert.equal((await call(a, '/transfers/' + payment.data.id, 'DELETE')).status, 200);
    assert.equal((await call(a, '/positions/' + cash)).data.amount, '1000');
    assert.equal((await call(a, '/positions/' + card)).data.amount, '200');

    for (const [fee, expected] of [
      ['-5.87654321', '955.87654321'],
      ['1.86420975', '948.13579025'],
    ] as const) {
      const movement = await call(a, '/transfers', 'POST', {
        sourceId: cash,
        targetId: card,
        amount: '50',
        received: '50',
        fee,
        date: '2026-09-03T11:00',
        requestId: randomUUID(),
      });
      assert.equal(movement.status, 201);
      assert.equal((await call(a, '/positions/' + cash)).data.amount, expected);
      assert.equal((await call(a, '/positions/' + card)).data.amount, '150');
      assert.equal((await call(a, '/transfers/' + movement.data.id, 'DELETE')).status, 200);
      assert.equal((await call(a, '/positions/' + cash)).data.amount, '1000');
      assert.equal((await call(a, '/positions/' + card)).data.amount, '200');
    }
    const invalidDiscount = await call(a, '/transfers', 'POST', {
      sourceId: cash,
      targetId: card,
      amount: '30',
      received: '30',
      fee: '-31',
      date: '2026-09-03T11:00',
      requestId: randomUUID(),
    });
    assert.equal(invalidDiscount.status, 400);
    assert.equal((await call(a, '/positions/' + cash)).data.amount, '1000');
    const loan = await create('测试独立欠款', 'debt', 'liability', 'personal', '200');
    for (const [fee, expected] of [
      ['-5', '975'],
      ['2', '968'],
    ] as const) {
      const movement = await call(a, '/transfers', 'POST', {
        operation: 'repay',
        sourceId: cash,
        targetId: loan,
        amount: '30',
        received: '30',
        fee,
        date: '2026-09-03T12:00',
        requestId: randomUUID(),
      });
      assert.equal(movement.status, 201);
      assert.equal((await call(a, '/positions/' + cash)).data.amount, expected);
      assert.equal((await call(a, '/positions/' + loan)).data.amount, '170');
      assert.equal((await call(a, '/transfers/' + movement.data.id, 'DELETE')).status, 200);
    }
    const month = today().slice(0, 7),
      path = '/positions/' + card + '/repayment-mark';
    assert.equal((await call(b, path, 'PATCH', { month, expectedMonth: null })).status, 404);
    assert.equal(
      (
        await call(a, '/positions/' + cash + '/repayment-mark', 'PATCH', {
          month,
          expectedMonth: null,
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(a, path, 'PATCH', { month: '2099-01', expectedMonth: null })).status,
      400,
    );
    const before = await call(a, '/positions/' + card);
    const marked = await call(a, path, 'PATCH', {
      month,
      expectedMonth: null,
      expectedUpdatedAt: before.data.updatedAt,
    });
    assert.equal(marked.status, 200);
    assert.equal((await call(a, '/positions/' + card)).data.lastRepaymentMonth, month);
    assert.equal((await call(a, '/positions/' + card)).data.amount, '200');
    assert.equal((await call(a, path, 'PATCH', { month: null, expectedMonth: null })).status, 409);
    const restored = await call(a, path, 'PATCH', {
      month: null,
      expectedMonth: month,
      expectedUpdatedAt: marked.data.updatedAt,
    });
    assert.equal(restored.status, 200);
    assert.equal((await call(a, '/positions/' + card)).data.lastRepaymentMonth, null);
    await call(a, path, 'PATCH', { month, expectedMonth: null });
    assert.equal(
      (
        await call(a, path, 'PATCH', {
          month: null,
          expectedMonth: month,
          expectedUpdatedAt: marked.data.updatedAt,
        })
      ).status,
      409,
    );
    const old = '2026-09';
    const changed = await call(a, path, 'PATCH', { month: old, expectedMonth: month });
    assert.equal(changed.status, 200);
    assert.equal((await call(a, '/positions/' + card)).data.lastRepaymentMonth, old);
    const hidden = await create('隐藏欠款', 'account', 'liability', 'loan', '5', true);
    assert.equal(
      (
        await call(a, '/positions/' + hidden + '/repayment-mark', 'PATCH', {
          month,
          expectedMonth: null,
        })
      ).status,
      404,
    );
    await db.session.update({
      where: { id: a.sid },
      data: { revealUntil: new Date(Date.now() + 600000) },
    });
    assert.equal(
      (
        await call(a, '/positions/' + hidden + '/repayment-mark', 'PATCH', {
          month,
          expectedMonth: null,
        })
      ).status,
      200,
    );
    await db.position.update({ where: { id: hidden }, data: { archived: true } });
    assert.equal(
      (
        await call(a, '/positions/' + hidden + '/repayment-mark', 'PATCH', {
          month: null,
          expectedMonth: month,
        })
      ).status,
      409,
    );
    // Derive daily status from surviving effective-time records; cover edits, deletes and both transfer sides.
    const dailySource = await create('daily source', 'account', 'asset', 'bank', '100');
    const dailyTarget = await create('daily target', 'account', 'asset', 'bank', '0');
    const activity = async (id: string) =>
      (await call(a, '/positions?kind=account')).data.find((p: any) => p.id === id).activityDate;
    const daily = await call(a, '/positions/' + dailySource + '/revisions', 'POST', {
      amount: '110',
      date: day + 'T00:00',
    });
    assert.equal(daily.status, 201);
    assert.equal(await activity(dailySource), day);
    const yesterday = new Date(+new Date(day) - 86400000).toISOString().slice(0, 10);
    assert.equal(
      (
        await call(a, '/positions/' + dailySource + '/revisions/' + daily.data.id, 'PUT', {
          amount: '110',
          date: yesterday + 'T23:59',
        })
      ).status,
      200,
    );
    assert.equal(await activity(dailySource), null);
    assert.equal(
      (
        await call(a, '/positions/' + dailySource + '/revisions/' + daily.data.id, 'PUT', {
          amount: '110',
          date: day + 'T00:00',
        })
      ).status,
      200,
    );
    assert.equal(await activity(dailySource), day);
    assert.equal(
      (await call(a, '/positions/' + dailySource + '/revisions/' + daily.data.id, 'DELETE')).status,
      200,
    );
    assert.equal(await activity(dailySource), null);
    const dailyTransfer = await call(a, '/transfers', 'POST', {
      sourceId: dailySource,
      targetId: dailyTarget,
      amount: '5',
      received: '5',
      fee: '0',
      date: day + 'T00:01',
      requestId: randomUUID(),
    });
    assert.equal(dailyTransfer.status, 201);
    assert.equal(await activity(dailySource), day);
    assert.equal(await activity(dailyTarget), day);
    assert.equal((await call(a, '/transfers/' + dailyTransfer.data.id, 'DELETE')).status, 200);
    assert.equal(await activity(dailySource), null);
    assert.equal(await activity(dailyTarget), null);
    const backup = await call(a, '/backup');
    assert.equal(backup.status, 200);
    assert.equal(backup.data.positions.find((p: any) => p.id === card).lastRepaymentMonth, old);
    const imported = await call(b, '/backup/restore-fixture', 'POST', {
      confirmed: true,
      backup: backup.data,
    });
    assert.equal(imported.status, 201);
    const rows = await db.position.findMany({ where: { userId: b.id } });
    assert.equal(rows.find((p) => p.name === '欠款账户')?.lastRepaymentMonth, old);
    assert.equal(rows.find((p) => p.name === '隐藏欠款')?.lastRepaymentMonth, month);
    assert.equal(rows.find((p) => p.name === '付款账户')?.lastBookedDate, day);
    assert.equal(rows.find((p) => p.category === 'commemorative_coin')?.included, false);
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
