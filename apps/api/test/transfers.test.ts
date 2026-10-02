import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readBackupZip } from '../src/zip';
import { normalizeIcon } from '../src/icons';
import sharp from 'sharp';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('transfers are atomic, scoped, retry-safe, decimal exact and included in backups', async () => {
  const db = new PrismaClient(),
    names: string[] = [];
  async function call(path: string, cookie = '', method = 'GET', data?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      data: r.headers.get('content-type')?.includes('application/zip')
        ? ((await readBackupZip(Buffer.from(await r.arrayBuffer()))) as any)
        : await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function account() {
    const username = 'wp_transfer_' + randomUUID(),
      password = randomBytes(18).toString('hex');
    names.push(username);
    const r = await call('/auth/register', '', 'POST', { username, password });
    assert.equal(r.status, 201);
    return { ...r, id: (await db.user.findUniqueOrThrow({ where: { username } })).id, password };
  }
  async function position(
    cookie: string,
    name: string,
    amount = '100',
    currency = 'CNY',
    side = 'asset',
  ) {
    const r = await call('/positions', cookie, 'POST', {
      name,
      kind: 'account',
      category: side === 'asset' ? 'bank' : 'credit_card',
      side,
      currency,
      amount,
      date: '2026-09-01T10:35',
    });
    assert.equal(r.status, 201);
    return r.data.id as string;
  }
  try {
    const a = await account(),
      b = await account();
    const sourceId = await position(a.cookie, '转出账户'),
      targetId = await position(a.cookie, '转入账户', '10'),
      other = await position(b.cookie, '他人账户');
    const request = {
      sourceId,
      targetId,
      amount: '25',
      received: '25',
      fee: '1',
      date: '2026-09-02T10:35',
      notes: '转账验收',
      requestId: randomUUID(),
    };
    assert.equal((await call('/transfers', '', 'POST', request)).status, 401);
    assert.equal(
      (await call('/transfers', a.cookie, 'POST', { ...request, targetId: other })).status,
      400,
    );
    assert.equal(
      (await call('/transfers', a.cookie, 'POST', { ...request, sourceId: targetId })).status,
      400,
    );
    assert.equal(
      (await call('/transfers', a.cookie, 'POST', { ...request, userId: b.id })).status,
      400,
    );
    assert.equal(
      (
        await call('/transfers', a.cookie, 'POST', {
          ...request,
          amount: '10000000000000000',
          received: '10000000000000000',
        })
      ).status,
      400,
    );
    assert.equal(await db.transfer.count({ where: { userId: a.id } }), 0);
    assert.equal(await db.revision.count({ where: { positionId: sourceId } }), 1);
    assert.equal((await call('/transfers', a.cookie, 'POST', request)).status, 201);
    assert.equal((await call('/transfers', a.cookie, 'POST', request)).status, 201);
    assert.equal(await db.transfer.count({ where: { userId: a.id } }), 1);
    assert.equal(
      (await call('/transfers', a.cookie, 'POST', { ...request, amount: '24', received: '24' }))
        .status,
      409,
    );
    const rows = (await call('/positions', a.cookie)).data;
    assert.equal(rows.find((p: any) => p.id === sourceId).amount, '74');
    assert.equal(rows.find((p: any) => p.id === targetId).amount, '35');
    assert.equal((await call('/overview', a.cookie)).data.net, '109.00');
    assert.equal((await call('/transfers', b.cookie)).data.items.length, 0);
    const revision = (await call('/positions/' + sourceId + '/history', a.cookie)).data.items[0];
    assert.equal(
      (
        await call(`/positions/${sourceId}/revisions/${revision.id}`, a.cookie, 'PUT', {
          amount: '70',
          date: request.date,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(`/positions/${sourceId}/revisions`, a.cookie, 'POST', {
          amount: '70',
          date: request.date,
          reason: 'transfer_out',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(`/positions/${sourceId}/revisions`, a.cookie, 'POST', {
          amount: '80',
          date: '2026-09-01T12:00',
          reason: 'balance',
        })
      ).status,
      409,
    );
    assert.equal((await call('/settings', a.cookie, 'PATCH', { showNotes: 'false' })).status, 400);
    const debt = await position(a.cookie, '信用卡', '10', 'CNY', 'liability');
    assert.equal(
      (
        await call('/transfers', a.cookie, 'POST', {
          ...request,
          requestId: randomUUID(),
          targetId: debt,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/transfers', a.cookie, 'POST', {
          ...request,
          requestId: randomUUID(),
          date: '2026-09-01T10:34',
        })
      ).status,
      409,
    );
    const usd = await position(a.cookie, '美元账户', '20', 'USD');
    assert.equal(
      (
        await call('/transfers', a.cookie, 'POST', {
          ...request,
          requestId: randomUUID(),
          sourceId: usd,
          amount: '1.00000001',
          received: '7.10000001',
          fee: '0',
          date: '2026-09-02T11:00',
        })
      ).status,
      201,
    );
    assert.equal(
      (await call('/positions', a.cookie)).data.find((p: any) => p.id === usd).amount,
      '18.99999999',
    );
    const race = await Promise.all(
      [1, 2].map(() =>
        call('/transfers', a.cookie, 'POST', {
          ...request,
          requestId: randomUUID(),
          sourceId: usd,
          amount: '15',
          received: '100',
          fee: '0',
          date: '2026-09-03T10:00',
        }),
      ),
    );
    assert.equal(
      race.filter((r) => r.status === 201).length,
      2,
      JSON.stringify(race.map((r) => ({ status: r.status, data: r.data }))),
    );
    assert.equal(race.filter((r) => [400, 409].includes(r.status)).length, 0);
    assert.equal(
      (await call('/positions', a.cookie)).data.find((p: any) => p.id === usd).amount,
      '-11.00000001',
    );
    assert.equal(
      (
        await call('/settings', a.cookie, 'PATCH', {
          hiddenMenus: ['asset', 'debt'],
          showNotes: false,
          idleMinutes: 15,
        })
      ).status,
      200,
    );
    assert.deepEqual((await call('/settings', a.cookie)).data.hiddenMenus, ['asset', 'debt']);
    assert.equal((await call('/settings', a.cookie)).data.showNotes, false);
    assert.equal(
      (await call('/settings', a.cookie, 'PATCH', { hiddenMenus: ['settings'] })).status,
      400,
    );
    assert.equal((await call('/settings', a.cookie, 'PATCH', { showSidebar: false })).status, 400);
    const backup = (await call('/backup', a.cookie)).data;
    assert.equal(backup.transfers.length, 4);
    assert.equal(backup.preferences.showNotes, false);
    assert.deepEqual(backup.preferences.hiddenMenus, ['asset', 'debt']);
    const broken = structuredClone(backup);
    broken.transfers[0].amount = '999';
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup: broken })).status,
      400,
    );
    assert.equal(await db.transfer.count({ where: { userId: b.id } }), 0);
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    const restored = (await call('/backup', b.cookie)).data;
    assert.equal(restored.transfers.length, 4);
    // Appending into an existing space preserves its display preferences.
    assert.equal((await call('/settings', b.cookie)).data.showNotes, true);
    const c = await account();
    assert.equal(
      (await call('/backup/import', c.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    assert.equal((await call('/settings', c.cookie)).data.showNotes, false);
    for (const t of restored.transfers) {
      assert.ok(
        restored.positions
          .find((p: any) => p.id === t.sourceId)
          ?.revisions.some((r: any) => r.id === t.sourceRevisionId),
      );
      assert.ok(
        restored.positions
          .find((p: any) => p.id === t.targetId)
          ?.revisions.some((r: any) => r.id === t.targetRevisionId),
      );
    }
    await call('/positions/' + sourceId, a.cookie, 'PATCH', {
      name: '转出账户',
      category: 'bank',
      hidden: true,
    });
    const visibleTransfers = (await call('/transfers', a.cookie)).data.items;
    assert.equal(visibleTransfers.length, 3);
    assert.ok(
      visibleTransfers.every((t: any) => t.sourceId !== sourceId && t.targetId !== sourceId),
    );
    assert.equal(
      (await call('/transfers', a.cookie, 'POST', { ...request, requestId: randomUUID() })).status,
      400,
    );
  } finally {
    await db.user.deleteMany({ where: { username: { in: names } } });
    await db.$disconnect();
  }
});
test('icon processing creates transparent white cutouts and preserves brand colour', async () => {
  const pixels = Buffer.from([255, 255, 255, 255, 10, 120, 60, 255]);
  const input = await sharp(pixels, { raw: { width: 2, height: 1, channels: 4 } })
    .png()
    .toBuffer();
  const output = await sharp(await normalizeIcon(input))
    .ensureAlpha()
    .raw()
    .toBuffer();
  assert.equal(output[3], 0);
  assert.deepEqual([...output.subarray(4)], [10, 120, 60, 255]);
});
test('OpenAPI exposes authenticated routes and actual transfer request fields', async () => {
  const r = await fetch(base + '/openapi.json');
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.ok(doc.paths['/api/transfers']);
  assert.ok(
    doc.paths['/api/transfers'].post.requestBody.content['application/json'].schema.properties
      .requestId,
  );
  assert.equal(doc.components.securitySchemes.session.in, 'cookie');
  assert.doesNotMatch(JSON.stringify(doc), /passwordHash|DATABASE_URL|ghp_/);
  const html = await fetch(base + '/docs');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /swagger-ui/);
});
