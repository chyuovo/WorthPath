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
        localAddress: '127.0.0.3',
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

async function position(
  u: any,
  name: string,
  kind = 'account',
  side = 'asset',
  initial = '1000',
  category = 'bank',
) {
  const r = await call('/positions', u.cookie, 'POST', {
    name,
    kind,
    side,
    category,
    currency: 'CNY',
    amount: initial,
    date: '2026-10-01T00:00',
    notes: '',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
test('all account transfer directions, replay, scheduled transfers and backup are consistent', async () => {
  const a = await fixture();
  try {
    const cash = await position(a, 'cash'),
      card = await position(a, 'card', 'account', 'liability', '200', 'credit_card'),
      other = await position(a, 'card2', 'account', 'liability', '300', 'loan');
    const payload = {
      sourceId: card,
      targetId: cash,
      amount: '100',
      received: '100',
      fee: '2',
      date: '2026-10-02T00:00',
      notes: '',
    };
    const t = await call('/transfers', a.cookie, 'POST', payload);
    assert.equal(t.status, 201, JSON.stringify(t.data));
    assert.equal(
      (
        await db.position.findUniqueOrThrow({
          where: { id: card },
          include: { revisions: { orderBy: { sequence: 'desc' }, take: 1 } },
        })
      ).revisions[0].amount.toString(),
      '302',
    );
    const t2 = await call('/transfers', a.cookie, 'POST', {
      ...payload,
      sourceId: cash,
      targetId: card,
      amount: '400',
      received: '400',
      fee: '0',
      date: '2026-10-02T01:00',
    });
    assert.equal(t2.status, 201);
    assert.equal((await call('/positions/' + card, a.cookie)).data.amount, '-98');
    assert.equal(
      (
        await call('/transfers/' + t.data.id, a.cookie, 'PUT', {
          ...payload,
          amount: '150',
          received: '150',
        })
      ).status,
      200,
    );
    assert.equal((await call('/positions/' + card, a.cookie)).data.amount, '-48');
    assert.equal((await call('/transfers/' + t2.data.id, a.cookie, 'DELETE')).status, 200);
    assert.equal((await call('/positions/' + card, a.cookie)).data.amount, '352');
    const plan = {
      name: 'credit transfer',
      operation: 'transfer',
      sourceId: card,
      targetId: other,
      amount: '50',
      received: '50',
      nextAt: '2026-10-02T02:00',
      intervalDays: 0,
      notes: '',
    };
    assert.equal((await call('/schedules', a.cookie, 'POST', plan)).status, 201);
    assert.equal((await call('/schedules/run', a.cookie, 'POST', {})).data.executed, 1);
    assert.equal((await call('/positions/' + other, a.cookie)).data.amount, '250');
    assert.equal(
      (
        await call('/schedules', a.cookie, 'POST', {
          ...plan,
          operation: 'expense',
          targetId: null,
        })
      ).status,
      400,
    );
    const backupController = (await import('../src/backup')).BackupController;
    const controller = new backupController(db as any);
    const backup = await (controller as any).data(a.id);
    assert.equal((await import('../src/backup')).validateBackup(backup).transfers?.length, 2);
  } finally {
    await db.user.delete({ where: { id: a.id } });
  }
});
test('inclusion preferences and precious metal settings, valuation and quotes restore exactly', async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const cash = await position(a, 'cash'),
      metal = await position(a, 'gold', 'asset', 'asset', '200', 'gold'),
      debt = await position(a, 'debt', 'debt', 'liability', '100', 'loan');
    assert.equal((await call('/overview', a.cookie)).data.net, '1100.00');
    assert.equal(
      (await call('/settings', a.cookie, 'PATCH', { includeIndependentAssets: false })).status,
      200,
    );
    assert.equal((await call('/overview', a.cookie)).data.net, '900.00');
    assert.equal(
      (
        await call('/positions/' + debt, a.cookie, 'PATCH', {
          name: 'debt',
          category: 'loan',
          included: false,
          notes: '',
        })
      ).status,
      200,
    );
    assert.equal((await call('/overview', a.cookie)).data.net, '1000.00');
    const tr = await call('/trend?from=2026-10-01&to=2026-10-03', a.cookie);
    assert.ok(tr.data.items.every((i: any) => i.net === '1000.00'));
    assert.equal(
      (
        await call('/metals/' + cash, a.cookie, 'PUT', {
          metalType: 'gold',
          metalGrams: '10',
          metalPurity: '0.999',
          autoValuation: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('/metals/' + metal, b.cookie, 'PUT', {
          metalType: 'gold',
          metalGrams: '10',
          metalPurity: '0.999',
          autoValuation: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call('/metals/' + metal, a.cookie, 'PUT', {
          metalType: 'gold',
          metalGrams: '10.86420978',
          metalPurity: '0.999',
          autoValuation: true,
        })
      ).status,
      200,
    );
    const d = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    assert.equal(
      (
        await call('/metals/prices', a.cookie, 'POST', {
          metalType: 'gold',
          currency: 'CNY',
          price: '700.864209789012',
          date: d,
        })
      ).status,
      201,
    );
    const expected = (await import('../src/metals')).metalValue(
      '10.86420978',
      '0.999',
      '700.864209789012',
    );
    assert.equal(
      (await call('/positions/' + metal, a.cookie)).data.amount,
      expected.replace(/0+$/, '').replace(/\.$/, ''),
    );
    const count = await db.revision.count({ where: { positionId: metal } });
    await call('/metals/prices', a.cookie, 'POST', {
      metalType: 'gold',
      currency: 'CNY',
      price: '700.864209789012',
      date: d,
    });
    assert.equal(await db.revision.count({ where: { positionId: metal } }), count);
    const controller = new (await import('../src/backup')).BackupController(db as any);
    const backup = await (controller as any).data(a.id);
    const archive = (await import('../src/zip')).archiveBackup(backup);
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((resolve) => archive.on('end', resolve));
    await archive.finalize();
    await done;
    const restoredBackup = await readBackupZip(Buffer.concat(chunks));
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup: restoredBackup }))
        .status,
      201,
    );
    assert.equal((await call('/auth/me', b.cookie)).data.includeIndependentAssets, false);
    const ps = (await call('/positions', b.cookie)).data;
    assert.equal(ps.find((p: any) => p.name === 'debt').included, false);
    assert.equal(ps.find((p: any) => p.name === 'gold').metalGrams, '10.86420978');
    assert.equal(
      (await db.metalPrice.findFirstOrThrow({ where: { userId: b.id } })).price.toString(),
      '700.864209789012',
    );
    const refreshed = await call('/metals/refresh', a.cookie, 'POST', {});
    assert.equal(refreshed.status, 201, JSON.stringify(refreshed.data));
    assert.equal(
      (
        await db.metalPrice.findFirstOrThrow({
          where: { userId: a.id, metalType: 'gold', currency: 'CNY', date: new Date(d) },
        })
      ).price.toString(),
      '700.864209789012',
    );
  } finally {
    await db.user.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await db.$disconnect();
  }
});
