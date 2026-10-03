import 'dotenv/config';
import { test } from 'node:test';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
const password = 'Fixture-session-only-42!';
const db = new PrismaClient();
async function fixture() {
  const u = await db.user.create({
    data: {
      username: 'wp_settings_' + randomUUID(),
      passwordHash: await hash(password, 4),
      idleMinutes: 0,
    },
  });
  const token = randomBytes(32).toString('hex');
  const id = createHash('sha256').update(token).digest('hex');
  await db.session.create({
    data: { id, userId: u.id, expiresAt: new Date(Date.now() + 86400000) },
  });
  return { ...u, sessionId: id, cookie: 'wp_session=' + token };
}
// Give this fixture suite its own loopback source address so independent auth
// scenarios do not consume the existing suite's per-IP production rate limit.
async function call(path: string, cookie: string, method = 'GET', body?: unknown) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; data: any; cookie: string | null }>((resolve, reject) => {
    const req = request(
      new URL(base + path),
      {
        method,
        localAddress: '127.0.0.2',
        headers: {
          Cookie: cookie,
          Origin: origin,
          ...(data === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode!,
              data: JSON.parse(Buffer.concat(chunks).toString()),
              cookie: res.headers['set-cookie']?.[0] ?? null,
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
test('session duration boundaries, privacy isolation and card settings survive backups', async () => {
  const a = await fixture(),
    b = await fixture(),
    c = await fixture();
  try {
    const initial = await call('/auth/me', a.cookie);
    assert.equal(initial.data.sessionHours, 168);
    assert.equal(initial.data.requireHiddenPassword, true);
    assert.equal(initial.data.overviewCards.length, 7);
    for (const sessionHours of [0, 721, 1.5, '24'])
      assert.equal((await call('/settings', a.cookie, 'PATCH', { sessionHours })).status, 400);
    for (const overviewCards of [['unknown'], ['net', 'net'], [1]])
      assert.equal((await call('/settings', a.cookie, 'PATCH', { overviewCards })).status, 400);
    assert.equal((await call('/auth/reveal', a.cookie, 'POST', {})).status, 400);
    assert.equal(
      (await call('/auth/reveal', a.cookie, 'POST', { password: 'Incorrect-password-42' })).status,
      403,
    );
    assert.equal((await call('/auth/reveal', a.cookie, 'POST', { password })).status, 201);
    const secondToken = randomBytes(32).toString('hex');
    const secondId = createHash('sha256').update(secondToken).digest('hex');
    const oldExpiry = new Date(Date.now() + 36000000);
    await db.session.create({
      data: {
        id: secondId,
        userId: a.id,
        expiresAt: oldExpiry,
        revealUntil: new Date(Date.now() + 60000),
      },
    });
    const result = await call('/settings', a.cookie, 'PATCH', {
      sessionHours: 1,
      requireHiddenPassword: false,
      overviewCards: ['net', 'recent'],
    });
    assert.equal(result.status, 200);
    assert.match(result.cookie!, /HttpOnly/);
    assert.match(result.cookie!, /Expires=/);
    const current = await db.session.findUniqueOrThrow({ where: { id: a.sessionId } });
    assert.ok(Math.abs(+current.expiresAt - Date.now() - 3600000) < 5000);
    assert.equal(current.revealUntil, null);
    const other = await db.session.findUniqueOrThrow({ where: { id: secondId } });
    assert.ok(Math.abs(+other.expiresAt - +oldExpiry) < 1000);
    assert.equal(other.revealUntil, null);
    assert.equal((await call('/auth/me', b.cookie)).data.requireHiddenPassword, true);
    assert.equal((await call('/auth/reveal', a.cookie, 'POST', {})).status, 201);
    assert.equal((await call('/auth/me', a.cookie)).data.revealed, true);
    await call('/settings', a.cookie, 'PATCH', { requireHiddenPassword: true });
    assert.equal((await call('/auth/me', a.cookie)).data.revealed, false);
    assert.equal((await call('/auth/reveal', a.cookie, 'POST', {})).status, 400);
    await call('/settings', a.cookie, 'PATCH', { sessionHours: 720, requireHiddenPassword: false });
    const login = await call('/auth/login', '', 'POST', { username: a.username, password });
    assert.equal(login.status, 201);
    const freshCookie = login.cookie!.split(';')[0];
    const me = (await call('/auth/me', freshCookie)).data;
    assert.ok(Math.abs(+new Date(me.sessionExpiresAt) - Date.now() - 720 * 3600000) < 5000);
    const zip = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.equal(zip.status, 200);
    const backup: any = await readBackupZip(Buffer.from(await zip.arrayBuffer()));
    assert.deepEqual(backup.preferences.overviewCards, ['net', 'recent']);
    assert.equal(backup.preferences.sessionHours, 720);
    assert.equal(backup.preferences.requireHiddenPassword, false);
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    const imported = (await call('/settings', b.cookie)).data;
    assert.equal(imported.sessionHours, 720);
    assert.equal(imported.requireHiddenPassword, false);
    assert.deepEqual(imported.overviewCards, ['net', 'recent']);
    delete backup.preferences.sessionHours;
    delete backup.preferences.requireHiddenPassword;
    delete backup.preferences.overviewCards;
    assert.equal(
      (await call('/backup/import', c.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    const legacy = (await call('/settings', c.cookie)).data;
    assert.equal(legacy.sessionHours, 168);
    assert.equal(legacy.requireHiddenPassword, true);
    assert.equal(legacy.overviewCards.length, 7);
    assert.equal((await call('/settings', a.cookie, 'PATCH', { overviewCards: [] })).status, 200);
    assert.deepEqual((await call('/auth/me', a.cookie)).data.overviewCards, []);
    await db.session.update({
      where: { id: a.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await call('/auth/me', a.cookie)).status, 401);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [a.id, b.id, c.id] } } });
  }
});
test('plan edits validate accounts, preserve history and reject hidden or foreign plans', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const position = async (name: string, hidden = false) => {
      const r = await call('/positions', a.cookie, 'POST', {
        name,
        kind: 'account',
        side: 'asset',
        category: 'cash',
        currency: 'CNY',
        amount: '100',
        date: '2026-09-01T10:00',
        hidden,
      });
      assert.equal(r.status, 201);
      return r.data.id;
    };
    const source = await position('Source'),
      target = await position('Target'),
      hidden = await position('Hidden', true);
    const payload = {
      name: 'Original',
      operation: 'expense',
      sourceId: source,
      targetId: null,
      amount: '10',
      received: '0',
      nextAt: '2026-10-01T10:00',
      intervalDays: 30,
      notes: 'initial',
    };
    const created = await call('/schedules', a.cookie, 'POST', payload);
    assert.equal(created.status, 201);
    const id = created.data.id;
    const run = await call('/schedules/run', a.cookie, 'POST', {});
    assert.equal(run.data.executed, 1);
    const records = await db.revision.findMany({
      where: { positionId: source },
      orderBy: { sequence: 'asc' },
    });
    const updated = {
      ...payload,
      name: 'Edited transfer',
      operation: 'transfer',
      targetId: target,
      amount: '20.00000001',
      received: '20.00000001',
      nextAt: '2027-01-01T09:00',
      intervalDays: 7,
      notes: 'new memo',
    };
    assert.equal((await call('/schedules/' + id, b.cookie, 'PUT', updated)).status, 404);
    assert.equal(
      (await call('/schedules/' + id, a.cookie, 'PUT', { ...updated, targetId: hidden })).status,
      400,
    );
    assert.equal(
      (await call('/schedules/' + id, a.cookie, 'PUT', { ...updated, received: '21' })).status,
      400,
    );
    assert.equal((await call('/schedules/' + id, a.cookie, 'PUT', updated)).status, 200);
    const plans = (await call('/schedules', a.cookie)).data;
    const plan = plans.find((p: any) => p.id === id);
    assert.equal(plan.name, updated.name);
    assert.equal(plan.nextAt, updated.nextAt);
    assert.equal(plan.received, updated.received);
    assert.equal(plan.notes, updated.notes);
    assert.equal(plan.enabled, true);
    assert.deepEqual(
      await db.revision.findMany({ where: { positionId: source }, orderBy: { sequence: 'asc' } }),
      records,
    );
    const done = await call('/schedules', a.cookie, 'POST', {
      ...payload,
      name: 'Once',
      intervalDays: 0,
    });
    await call('/schedules/run', a.cookie, 'POST', {});
    assert.equal((await call('/schedules/' + done.data.id, a.cookie, 'PUT', updated)).status, 400);
    await db.position.update({ where: { id: source }, data: { hidden: true } });
    assert.equal((await call('/schedules/' + id, a.cookie, 'PUT', updated)).status, 404);
  } finally {
    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await db.$disconnect();
  }
});
