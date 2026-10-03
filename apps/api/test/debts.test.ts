import { fixtureFetch } from './backup-fixture';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupZip, packBackup } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
test('borrow/lend/collect/repay pair balances atomically and survive concurrency and restore', async () => {
  const db = new PrismaClient(),
    users: string[] = [];
  async function user() {
    const row = await db.user.create({
      data: { username: 'wp_debt_' + randomUUID(), passwordHash: 'not-a-login-hash' },
    });
    users.push(row.id);
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: createHash('sha256').update(token).digest('hex'),
        userId: row.id,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    return { id: row.id, token };
  }
  async function call(token: string, path: string, method = 'GET', body?: unknown) {
    const response = await fixtureFetch(base + path, {
      method,
      headers: {
        Cookie: 'wp_session=' + token,
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: response.headers.get('content-type')?.includes('application/zip')
        ? ((await readBackupZip(Buffer.from(await response.arrayBuffer()))) as any)
        : await response.json(),
    };
  }
  try {
    const a = await user(),
      b = await user();
    async function position(name: string, kind: string, side: string, amount = '0') {
      const result = await call(a.token, '/positions', 'POST', {
        name,
        kind,
        side,
        amount,
        currency: 'CNY',
        category: kind === 'debt' ? 'personal' : 'bank',
        date: '2026-09-01T00:00',
      });
      assert.equal(result.status, 201);
      return result.data.id as string;
    }
    const cash = await position('test account', 'account', 'asset', '1000'),
      borrowed = await position('test borrowed', 'debt', 'liability'),
      lent = await position('test lent', 'debt', 'asset');
    const request = (operation: string, targetId: string, amount: string, fee = '0') => ({
      requestId: randomUUID(),
      operation,
      sourceId: cash,
      targetId,
      amount,
      received: amount,
      fee,
      date: '2026-09-02T10:00',
    });
    const borrow = request('borrow', borrowed, '100', '2');
    const parallel = await Promise.all([
      call(a.token, '/transfers', 'POST', borrow),
      call(a.token, '/transfers', 'POST', borrow),
    ]);
    assert.deepEqual(
      parallel.map((r) => r.status),
      [201, 201],
    );
    assert.equal((await call(a.token, '/overview')).data.net, '998.00');
    assert.equal(
      (await call(a.token, '/transfers', 'POST', request('lend', lent, '200', '-2'))).status,
      201,
    );
    assert.equal((await call(a.token, '/overview')).data.net, '1000.00');
    assert.equal(
      (await call(a.token, '/transfers', 'POST', request('collect', lent, '50'))).status,
      201,
    );
    assert.equal(
      (await call(a.token, '/transfers', 'POST', request('repay', borrowed, '30', '1'))).status,
      201,
    );
    assert.equal((await call(a.token, '/overview')).data.net, '999.00');
    const list = (await call(a.token, '/positions')).data;
    assert.equal(list.find((p: any) => p.id === cash).amount, '919');
    assert.equal(list.find((p: any) => p.id === borrowed).amount, '70');
    assert.equal(list.find((p: any) => p.id === lent).amount, '150');
    assert.equal(list.find((p: any) => p.id === lent).outgoing[0].targetId, cash);
    const count = await db.revision.count({ where: { position: { userId: a.id } } });
    assert.equal(
      (await call(a.token, '/transfers', 'POST', request('repay', borrowed, '71'))).status,
      400,
    );
    assert.equal(
      (await call(a.token, '/transfers', 'POST', request('lend', borrowed, '10'))).status,
      400,
    );
    assert.equal(
      (await call(b.token, '/transfers', 'POST', request('repay', borrowed, '10'))).status,
      400,
    );
    assert.equal(await db.revision.count({ where: { position: { userId: a.id } } }), count);
    const race = await Promise.all(
      [1, 2].map(() => call(a.token, '/transfers', 'POST', request('collect', lent, '100'))),
    );
    assert.equal(race.filter((r) => r.status === 201).length, 1, JSON.stringify(race));
    assert.equal(race.filter((r) => r.status === 400 || r.status === 409).length, 1);
    const paired = (await call(a.token, '/positions/' + cash + '/history')).data.items.find(
      (r: any) => r.reason === 'loan_collect',
    );
    assert.equal(
      (
        await call(a.token, '/positions/' + cash + '/revisions/' + paired.id, 'PUT', {
          amount: '1',
          date: '2026-09-02T10:00',
        })
      ).status,
      409,
    );
    // A later record at the same business minute can be corrected by sequence.
    assert.equal(
      (
        await call(a.token, '/positions/' + cash + '/revisions', 'POST', {
          amount: '1020',
          date: '2026-09-02T10:00',
        })
      ).status,
      201,
    );
    const latest = (await call(a.token, '/positions/' + cash + '/history?limit=1')).data.items[0];
    assert.equal(
      (
        await call(a.token, '/positions/' + cash + '/revisions/' + latest.id, 'PUT', {
          amount: '1021',
          date: '2026-09-02T10:00',
        })
      ).status,
      200,
    );
    const backup = (await call(a.token, '/backup')).data;
    assert.equal(JSON.parse(packBackup(backup)['manifest.json']).version, 9);
    assert.equal(backup.transfers.length, 5);
    assert.ok(backup.transfers.some((p: any) => p.operation === 'lend' && p.fee === '-2'));
    assert.equal(
      (await call(b.token, '/backup/restore-fixture', 'POST', { confirmed: true, backup })).status,
      201,
    );
    assert.equal(
      (await call(b.token, '/overview')).data.net,
      (await call(a.token, '/overview')).data.net,
    );
    assert.equal(await db.transfer.count({ where: { userId: b.id } }), 5);
    const restored = (await call(b.token, '/positions?kind=debt')).data;
    assert.equal(restored.find((p: any) => p.side === 'asset').amount, '50');
    assert.equal(restored.find((p: any) => p.side === 'liability').amount, '70');
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
