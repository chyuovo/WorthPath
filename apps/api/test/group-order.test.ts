import { fixtureFetch } from './backup-fixture';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('group order persists per user, validates input and survives ZIP and reject incomplete imports', async () => {
  const db = new PrismaClient(),
    ids: string[] = [];
  const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
  async function user() {
    const u = await db.user.create({
      data: { username: 'wp_groups_' + randomUUID(), passwordHash: 'unused' },
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
    const res = await fixtureFetch(base + path, {
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
      b = await user(),
      c = await user();
    assert.deepEqual((await call('/auth/me', a.cookie)).data.accountGroupOrder, []);
    const order = ['理财', '', '未分组', '日常'];
    assert.equal(
      (await call('/settings', a.cookie, 'PATCH', { accountGroupOrder: order })).status,
      200,
    );
    assert.deepEqual(
      (await db.user.findUniqueOrThrow({ where: { id: a.id } })).accountGroupOrder,
      order,
    );
    assert.deepEqual((await call('/auth/me', a.cookie)).data.accountGroupOrder, order);
    assert.deepEqual((await call('/settings', a.cookie)).data.accountGroupOrder, order);
    assert.deepEqual((await call('/settings', b.cookie)).data.accountGroupOrder, []);
    for (const invalid of [['日常', '日常'], [' 日常 ', '日常'], [42], ['x'.repeat(61)]]) {
      assert.equal(
        (await call('/settings', a.cookie, 'PATCH', { accountGroupOrder: invalid })).status,
        400,
      );
    }
    assert.deepEqual((await call('/settings', a.cookie)).data.accountGroupOrder, order);
    assert.equal(
      (
        await call('/positions', a.cookie, 'POST', {
          name: 'Daily',
          kind: 'account',
          side: 'asset',
          category: 'cash',
          groupName: '日常',
          currency: 'CNY',
          amount: '20',
          date: '2026-09-01T10:00',
        })
      ).status,
      201,
    );
    const zip = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.equal(zip.status, 200);
    const backup: any = await readBackupZip(Buffer.from(await zip.arrayBuffer()));
    assert.deepEqual(backup.preferences.accountGroupOrder, order);
    assert.equal(
      (await call('/backup/restore-fixture', b.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    assert.deepEqual((await call('/auth/me', b.cookie)).data.accountGroupOrder, order);
    await call('/settings', b.cookie, 'PATCH', { accountGroupOrder: ['日常'] });
    assert.equal(
      (await call('/backup/restore-fixture', b.cookie, 'POST', { confirmed: true, backup })).status,
      409,
    );
    assert.deepEqual((await call('/settings', b.cookie)).data.accountGroupOrder, ['日常']);
    delete backup.preferences.accountGroupOrder;
    assert.equal(
      (await call('/backup/restore-fixture', c.cookie, 'POST', { confirmed: true, backup })).status,
      400,
    );
    assert.deepEqual((await call('/auth/me', c.cookie)).data.accountGroupOrder, []);
    const comments: any[] = await db.$queryRawUnsafe(
      "SELECT COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'accountGroupOrder'",
    );
    assert.ok(comments[0].comment.includes('分组'));
  } finally {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
