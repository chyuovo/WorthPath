import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('privacy, minute history, backup-gated clear and idle sessions remain user scoped', async () => {
  const db = new PrismaClient(),
    names: string[] = [];
  async function call(path: string, method = 'GET', data?: unknown, cookie = '') {
    const res = await fetch(base + path, {
      method,
      headers: {
        Origin: process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!,
        Cookie: cookie,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
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
    const username = 'wp_privacy_' + randomUUID(),
      password = randomBytes(18).toString('hex');
    names.push(username);
    const r = await call('/auth/register', 'POST', { username, password });
    assert.equal(r.status, 201);
    const u = await db.user.findUniqueOrThrow({ where: { username } });
    return { ...r, username, password, id: u.id };
  }
  const sessionId = (cookie: string) =>
    createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  try {
    const a = await account(),
      b = await account();
    async function position(cookie: string, hidden: boolean, amount: string) {
      const r = await call(
        '/positions',
        'POST',
        {
          kind: 'account',
          side: 'asset',
          category: 'bank',
          name: 'Temporary privacy acceptance',
          currency: 'CNY',
          amount,
          date: '2026-09-01T09:17',
          hidden,
        },
        cookie,
      );
      assert.equal(r.status, 201);
      return r.data.id as string;
    }
    const visible = await position(a.cookie, false, '20'),
      hidden = await position(a.cookie, true, '80');
    await position(b.cookie, false, '7');
    assert.equal((await call('/overview', 'GET', undefined, a.cookie)).data.net, '20.00');
    assert.equal((await call('/positions', 'GET', undefined, a.cookie)).data.length, 1);
    assert.equal((await call('/positions/' + hidden, 'GET', undefined, a.cookie)).status, 404);
    assert.equal(
      (
        await call(
          '/positions/' + hidden + '/revisions',
          'POST',
          { amount: '90', date: '2026-09-01T09:18' },
          a.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (await call('/auth/reveal', 'POST', { password: b.password }, a.cookie)).status,
      403,
    );
    assert.equal(
      (await call('/auth/reveal', 'POST', { password: a.password, userId: b.id }, a.cookie)).status,
      400,
    );
    assert.equal(
      (await call('/auth/reveal', 'POST', { password: a.password }, a.cookie)).status,
      201,
    );
    assert.equal((await call('/overview', 'GET', undefined, a.cookie)).data.net, '100.00');
    assert.equal((await call('/overview', 'GET', undefined, b.cookie)).data.net, '7.00');
    const otherSession = await call('/auth/login', 'POST', {
      username: a.username,
      password: a.password,
    });
    assert.equal(
      (await call('/overview', 'GET', undefined, otherSession.cookie)).data.net,
      '20.00',
    );
    assert.equal(
      (
        await call(
          '/positions/' + hidden + '/revisions',
          'POST',
          { amount: '95', date: '2026-09-01T09:18' },
          a.cookie,
        )
      ).status,
      201,
    );
    const history = (await call('/positions/' + hidden, 'GET', undefined, a.cookie)).data.history;
    assert.deepEqual(
      history.map((h: { time: string }) => h.time),
      ['2026-09-01T09:17', '2026-09-01T09:18'],
    );
    assert.equal(history[1].delta, '15');
    const backup = (await call('/backup', 'GET', undefined, a.cookie)).data;
    assert.equal(backup.version, 2);
    assert.equal(backup.positions.find((p: { id: string }) => p.id === hidden).hidden, true);
    assert.equal(
      backup.positions.find((p: { id: string }) => p.id === hidden).revisions[0].date,
      '2026-09-01T09:17',
    );
    const c = await account();
    const download = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.match(download.headers.get('content-disposition')!, /\.zip/);
    const bytes = await download.arrayBuffer();
    async function upload(cookie: string, content: ArrayBuffer | string) {
      const form = new FormData();
      form.append('file', new Blob([content]), 'backup.zip');
      const res = await fetch(base + '/backup/upload', {
        method: 'POST',
        headers: {
          Origin:
            process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!,
          Cookie: cookie,
        },
        body: form,
      });
      return { status: res.status, data: await res.json() };
    }
    assert.equal((await upload(c.cookie, 'invalid zip')).status, 400);
    assert.equal(await db.position.count({ where: { userId: c.id } }), 0);
    const uploaded = await upload(c.cookie, bytes);
    assert.equal(uploaded.status, 201);
    assert.equal(
      (
        await call(
          '/backup/import-file',
          'POST',
          { confirmed: true, token: uploaded.data.token },
          b.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          '/backup/import-file',
          'POST',
          { confirmed: false, token: uploaded.data.token },
          c.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          '/backup/import-file',
          'POST',
          { confirmed: true, token: uploaded.data.token },
          c.cookie,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          '/backup/import-file',
          'POST',
          { confirmed: true, token: uploaded.data.token },
          c.cookie,
        )
      ).status,
      400,
    );
    assert.equal((await call('/overview', 'GET', undefined, c.cookie)).data.net, '20.00');
    assert.equal(
      (await call('/backup/import', 'POST', { confirmed: true, backup }, b.cookie)).status,
      201,
    );
    assert.equal((await call('/overview', 'GET', undefined, b.cookie)).data.net, '27.00');
    await call('/auth/reveal', 'POST', { password: b.password }, b.cookie);
    assert.equal((await call('/overview', 'GET', undefined, b.cookie)).data.net, '122.00');
    await db.session.update({
      where: { id: sessionId(a.cookie) },
      data: { revealUntil: new Date(Date.now() - 1000) },
    });
    assert.equal((await call('/overview', 'GET', undefined, a.cookie)).data.net, '20.00');
    assert.equal(
      (await call('/backup/clear', 'POST', { confirmation: '确定清空' }, otherSession.cookie))
        .status,
      400,
    );
    assert.equal(
      (await call('/backup/clear', 'POST', { confirmation: '清空' }, a.cookie)).status,
      400,
    );
    await call(
      '/positions/' + visible + '/revisions',
      'POST',
      { amount: '21', date: '2026-09-01T10:12' },
      a.cookie,
    );
    assert.equal(
      (await call('/backup/clear', 'POST', { confirmation: '确定清空' }, a.cookie)).status,
      409,
    );
    assert.equal(await db.position.count({ where: { userId: a.id } }), 2);
    await call('/backup', 'GET', undefined, a.cookie);
    assert.equal(
      (await call('/backup/clear', 'POST', { confirmation: '确定清空', userId: b.id }, a.cookie))
        .status,
      400,
    );
    assert.equal(
      (await call('/backup/clear', 'POST', { confirmation: '确定清空' }, a.cookie)).status,
      201,
    );
    assert.equal(await db.position.count({ where: { userId: a.id } }), 0);
    assert.equal(await db.exchangeRate.count({ where: { userId: a.id } }), 0);
    assert.equal(await db.position.count({ where: { userId: b.id } }), 3);
    assert.equal((await call('/auth/me', 'GET', undefined, a.cookie)).status, 200);
    assert.equal(
      (await call('/settings', 'PATCH', { hiddenMenus: ['asset'], idleMinutes: 1 }, a.cookie))
        .status,
      200,
    );
    const prefs = (await call('/settings', 'GET', undefined, a.cookie)).data;
    assert.deepEqual(prefs.hiddenMenus, ['asset']);
    assert.equal(prefs.idleMinutes, 1);
    assert.equal((await call('/settings', 'PATCH', { idleMinutes: -1 }, a.cookie)).status, 400);
    await db.session.update({
      where: { id: sessionId(a.cookie) },
      data: { lastActivity: new Date(Date.now() - 61000) },
    });
    assert.equal((await call('/auth/me', 'GET', undefined, a.cookie)).status, 401);
    assert.equal((await call('/auth/activity', 'POST', undefined, a.cookie)).status, 401);
    assert.equal((await call('/auth/me', 'GET', undefined, b.cookie)).status, 200);
    const legacy = {
      ...backup,
      version: 1,
      positions: backup.positions.map((p: any) => {
        const { hidden, ...rest } = p;
        return {
          ...rest,
          revisions: p.revisions.map((r: any) => ({ ...r, date: r.date.slice(0, 10) })),
        };
      }),
    };
    assert.equal((await call('/auth/me', 'GET', undefined, otherSession.cookie)).status, 200);
    const login = await call('/auth/login', 'POST', { username: a.username, password: a.password });
    assert.equal(
      (await call('/backup/import', 'POST', { confirmed: true, backup: legacy }, login.cookie))
        .status,
      201,
    );
    assert.equal((await call('/positions', 'GET', undefined, login.cookie)).data.length, 2);
  } finally {
    for (const username of names) await db.user.deleteMany({ where: { username } });
    await db.$disconnect();
  }
});
