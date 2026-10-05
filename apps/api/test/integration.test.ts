import { provisionTestUser } from './user-fixture';
import { fixtureFetch } from './backup-fixture';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { today } from '../src/validation';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api',
  origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
test('real MySQL: authentication, isolation, history, backup and atomic failures', async () => {
  const db = new PrismaClient(),
    created: { id: string; username: string }[] = [];
  async function call(path: string, method = 'GET', body?: unknown, cookie = '') {
    const res = await fixtureFetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      data: res.headers.get('content-type')?.includes('application/zip')
        ? ((await readBackupZip(Buffer.from(await res.arrayBuffer()))) as any)
        : await res.json(),
      cookie: res.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function account() {
    const username = 'wp_test_' + randomUUID().slice(0, 12),
      password = randomBytes(18).toString('hex');
    await provisionTestUser({ username, password });
    const r = await call('/auth/login', 'POST', { username, password });
    assert.equal(r.status, 201);
    assert.ok(r.cookie);
    const u = await db.user.findUniqueOrThrow({ where: { username } });
    created.push({ id: u.id, username });
    assert.notEqual(u.passwordHash, password);
    assert.equal('passwordHash' in r.data, false);
    return { ...r, password, username };
  }
  try {
    assert.equal((await call('/positions')).status, 401);
    const a = await account(),
      b = await account();
    assert.equal(
      (
        await fetch(base + '/settings', {
          method: 'PATCH',
          headers: {
            Cookie: a.cookie,
            'Content-Type': 'application/json',
            Origin: 'https://untrusted.invalid',
          },
          body: JSON.stringify({ hiddenMenus: [] }),
        })
      ).status,
      process.env.WEB_ORIGIN === '*' ? 200 : 403,
    );
    const make = async (
      kind: string,
      side: string,
      currency: string,
      value: string,
      category = 'other',
    ) => {
      const r = await call(
        '/positions',
        'POST',
        {
          name: kind + randomUUID().slice(0, 5),
          kind,
          side,
          currency,
          amount: value,
          category,
          date: '2026-09-01',
          notes: '',
        },
        a.cookie,
      );
      assert.equal(r.status, 201);
      return r.data.id as string;
    };
    const bank = await make('account', 'asset', 'CNY', '100.10'),
      asset = await make('asset', 'asset', 'USD', '100'),
      debt = await make('debt', 'liability', 'CNY', '200'),
      card = await make('account', 'liability', 'CNY', '50', 'credit_card');
    assert.equal((await call('/positions/' + bank, 'GET', undefined, b.cookie)).status, 404);
    assert.equal(
      (
        await call(
          '/positions/' + bank,
          'PATCH',
          { name: 'hack', category: 'other', notes: '', archived: false },
          b.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions',
          'POST',
          { amount: '1', date: '2026-09-02' },
          b.cookie,
        )
      ).status,
      404,
    );
    assert.deepEqual((await call('/positions', 'GET', undefined, b.cookie)).data, []);
    assert.equal(
      (
        await call(
          '/positions',
          'POST',
          {
            name: 'hack',
            kind: 'asset',
            side: 'asset',
            currency: 'CNY',
            category: 'other',
            amount: '1',
            date: '2026-09-01',
            userId: created[0].id,
          },
          b.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          '/rates',
          'PUT',
          { currency: 'USD', baseCurrency: 'CNY', rate: '7', date: '2026-09-01' },
          a.cookie,
        )
      ).status,
      404,
    );
    const owner = await db.user.findUniqueOrThrow({ where: { username: a.username } });
    for (const businessDay of ['2026-09-01', today()]) {
      const key = {
        userId: owner.id,
        currency: 'USD',
        baseCurrency: 'CNY',
        date: new Date(businessDay),
      };
      await db.exchangeRate.upsert({
        where: { userId_currency_baseCurrency_date: key },
        create: { ...key, rate: '7', source: 'manual' },
        update: { rate: '7', source: 'manual' },
      });
    }
    let o = (await call('/overview', 'GET', undefined, a.cookie)).data;
    assert.equal(o.complete, true);
    assert.equal(o.net, '550.10');
    assert.equal(
      (await call('/positions/' + debt + '/links', 'PUT', { targetIds: [asset, bank] }, a.cookie))
        .status,
      200,
    );
    assert.equal((await call('/overview', 'GET', undefined, a.cookie)).data.net, '550.10');
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions',
          'POST',
          { amount: '110.10', date: '2026-09-02' },
          a.cookie,
        )
      ).status,
      201,
    );
    const d = {
      history: (
        await call('/positions/' + bank + '/history', 'GET', undefined, a.cookie)
      ).data.items.reverse(),
    };
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions/' + d.history[0].id,
          'PUT',
          { amount: '90.10', date: '2026-09-01' },
          b.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions/' + d.history[0].id,
          'PUT',
          { amount: '90.10', date: '2026-09-01' },
          a.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call('/positions/' + bank + '/history', 'GET', undefined, a.cookie)).data.items[0]
        .delta,
      '20',
    );
    assert.equal(
      (
        await call(
          '/positions/' + card + '/revisions',
          'POST',
          { amount: '40', date: '2026-09-02', reason: 'repayment' },
          a.cookie,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          '/positions/' + card,
          'PATCH',
          { name: 'card', category: 'credit_card', notes: '', archived: true },
          a.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          '/positions/' + card + '/revisions',
          'POST',
          { amount: '0', date: '2026-09-03' },
          a.cookie,
        )
      ).status,
      409,
    );
    o = (await call('/overview', 'GET', undefined, a.cookie)).data;
    assert.equal(o.net, '570.10');
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions',
          'POST',
          { amount: '120.10', date: '2026-09-02' },
          a.cookie,
        )
      ).status,
      201,
    );
    const sameDay = (
      await call('/positions/' + bank + '/history', 'GET', undefined, a.cookie)
    ).data.items.reverse();
    assert.equal(sameDay.length, 3);
    assert.equal(sameDay[2].after, '120.1');
    assert.equal(sameDay[2].delta, '10');
    assert.ok(sameDay[2].sequence > sameDay[1].sequence);
    assert.equal(
      (
        await call(
          '/positions/' + bank + '/revisions',
          'POST',
          { amount: '0', date: '2026-09-03', reason: 'repayment' },
          a.cookie,
        )
      ).status,
      400,
    );
    o = (await call('/overview', 'GET', undefined, a.cookie)).data;
    assert.equal(o.net, '580.10');
    const backup = (await call('/backup', 'GET', undefined, a.cookie)).data;
    assert.equal(backup.positions.length, 4);
    assert.equal(backup.links.length, 2);
    assert.doesNotMatch(
      JSON.stringify(backup),
      /"(?:password|passwordHash|token|userId|session|sessionId|sessions|cookie)"\s*:/i,
    );
    assert.equal((await call('/backup/preview-fixture', 'POST', backup, a.cookie)).status, 409);
    assert.equal((await call('/backup/preview-fixture', 'POST', backup, b.cookie)).status, 201);
    assert.equal(
      (await call('/backup/restore-fixture', 'POST', { confirmed: false, backup }, b.cookie))
        .status,
      400,
    );
    assert.equal(
      (
        await call(
          '/backup/restore-fixture',
          'POST',
          {
            confirmed: true,
            backup: { ...backup, links: [{ sourceId: randomUUID(), targetId: asset }] },
          },
          b.cookie,
        )
      ).status,
      400,
    );
    assert.equal((await call('/positions', 'GET', undefined, b.cookie)).data.length, 0);
    assert.equal(
      (await call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, b.cookie)).status,
      201,
    );
    assert.equal((await call('/overview', 'GET', undefined, b.cookie)).data.net, o.net);
    const restored = (await call('/positions', 'GET', undefined, b.cookie)).data;
    assert.equal(restored.length, 4);
    assert.ok(
      restored.every(
        (p: { id: string }) => !backup.positions.some((q: { id: string }) => q.id === p.id),
      ),
    );
    assert.equal(restored.find((p: { kind: string }) => p.kind === 'debt').outgoing.length, 2);
    const restoredAccount = restored.find(
      (p: { kind: string; side: string }) => p.kind === 'account' && p.side === 'asset',
    );
    const restoredHistory = (
      await call('/positions/' + restoredAccount.id + '/history', 'GET', undefined, b.cookie)
    ).data.items.reverse();
    assert.deepEqual(
      restoredHistory.map((h: { after: string }) => h.after),
      sameDay.map((h: { after: string }) => h.after),
    );
    assert.equal(
      (await call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, b.cookie)).status,
      409,
    );
    assert.equal((await call('/positions', 'GET', undefined, b.cookie)).data.length, 4);
    const restoredBank = restored.find(
      (p: { kind: string; side: string; currency: string }) =>
        p.kind === 'account' && p.side === 'asset' && p.currency === 'CNY',
    );
    await call(
      '/positions/' + restoredBank.id,
      'PATCH',
      {
        name: 'Edited imported project',
        category: restoredBank.category,
        notes: 'Edited after import',
        archived: false,
      },
      b.cookie,
    );
    assert.equal(
      (await call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, b.cookie)).status,
      409,
    );
    const c = await account();
    const racing = await Promise.all([
      call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, c.cookie),
      call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, c.cookie),
    ]);
    assert.deepEqual(racing.map((r) => r.status).sort(), [201, 400]);
    assert.equal((await call('/positions', 'GET', undefined, c.cookie)).data.length, 4);
    assert.equal((await call('/auth/logout', 'POST', undefined, a.cookie)).status, 201);
    assert.equal((await call('/auth/me', 'GET', undefined, a.cookie)).status, 401);
    assert.equal((await call('/backup', 'GET', undefined, a.cookie)).status, 401);
    assert.equal(
      (await call('/backup/restore-fixture', 'POST', { confirmed: true, backup }, a.cookie)).status,
      401,
    );
    const login = await call('/auth/login', 'POST', { username: a.username, password: a.password });
    assert.equal(login.status, 201);
    assert.equal((await call('/positions', 'GET', undefined, login.cookie)).data.length, 4);
  } finally {
    for (const u of created)
      await db.user.deleteMany({ where: { id: u.id, username: u.username } });
    await db.$disconnect();
  }
});
