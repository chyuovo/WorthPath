import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('private and shared icons, account reuse and complete ZIP restoration preserve isolation', async () => {
  const db = new PrismaClient(),
    names: string[] = [],
    publicIds: string[] = [];
  async function call(path: string, cookie = '', method = 'GET', data?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: res.status,
      data: res.headers.get('content-type')?.includes('application/zip')
        ? ((await readBackupZip(Buffer.from(await res.arrayBuffer()))) as any)
        : res.headers.get('content-type')?.includes('application/json')
          ? await res.json()
          : Buffer.from(await res.arrayBuffer()),
      cookie: res.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function account() {
    const username = 'wp_icons_' + randomUUID();
    names.push(username);
    const r = await call('/auth/register', '', 'POST', {
      username,
      password: randomBytes(18).toString('hex'),
    });
    assert.equal(r.status, 201);
    return { ...r, id: (await db.user.findUniqueOrThrow({ where: { username } })).id };
  }
  const image = await sharp({
    create: { width: 400, height: 400, channels: 4, background: '#097c71' },
  })
    .png()
    .toBuffer();
  async function upload(
    cookie: string,
    name: string,
    shared = false,
    confirmed = false,
    content = image,
  ) {
    const f = new FormData();
    f.append('file', new Blob([new Uint8Array(content)], { type: 'image/png' }), 'icon.png');
    f.append('name', name);
    f.append('shared', String(shared));
    if (confirmed) f.append('confirmed', 'true');
    const r = await fetch(base + '/icons/upload', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'http://localhost:5173' },
      body: f,
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    const a = await account(),
      b = await account();
    assert.equal((await call('/icons')).status, 401);
    const own = await upload(a.cookie, '我的银行');
    assert.equal(own.status, 201);
    assert.equal((await upload(a.cookie, '同一图片')).data.id, own.data.id);
    assert.equal((await call('/icons/' + own.data.id + '/image', b.cookie)).status, 404);
    assert.equal(
      (await call('/icons?q=' + encodeURIComponent('我的银行'), b.cookie)).data.total,
      0,
    );
    const privateImage = await call('/icons/' + own.data.id + '/image', a.cookie);
    assert.equal(privateImage.status, 200);
    assert.equal((await sharp(privateImage.data).metadata()).width, 256);
    assert.equal((await upload(a.cookie, 'English', true, true)).status, 400);
    assert.equal((await upload(a.cookie, '共享银行', true)).status, 400);
    assert.equal(
      (await upload(a.cookie, '坏图标', false, false, Buffer.from('<svg onload="alert(1)"/>')))
        .status,
      400,
    );
    const shared = await upload(a.cookie, '共享测试银行', true, true);
    assert.equal(shared.status, 201);
    publicIds.push(shared.data.id);
    assert.equal((await call('/icons/' + shared.data.id + '/image', b.cookie)).status, 200);
    assert.equal(
      (await call('/icons?q=' + encodeURIComponent('共享测试银行'), b.cookie)).data.items.some(
        (i: any) => i.id === shared.data.id,
      ),
      true,
    );
    const meta = {
      kind: 'account',
      side: 'asset',
      category: 'bank',
      name: '图标关联验收',
      currency: 'CNY',
      amount: '10',
      date: '2026-09-01T10:35',
    };
    assert.equal(
      (await call('/positions', b.cookie, 'POST', { ...meta, iconId: own.data.id })).status,
      400,
    );
    const p = await call('/positions', a.cookie, 'POST', { ...meta, iconId: own.data.id });
    assert.equal(p.status, 201);
    assert.equal(
      (await call('/positions', a.cookie, 'POST', { ...meta, iconId: own.data.id })).status,
      201,
    );
    const other = await call('/positions', b.cookie, 'POST', { ...meta, iconId: shared.data.id });
    assert.equal(other.status, 201);
    assert.equal(
      (
        await call('/positions/' + other.data.id, b.cookie, 'PATCH', {
          name: meta.name,
          category: 'bank',
          iconId: own.data.id,
        })
      ).status,
      400,
    );
    assert.equal(
      (await db.position.findUniqueOrThrow({ where: { id: other.data.id } })).iconId,
      shared.data.id,
    );
    assert.equal(
      (
        await call('/positions/' + p.data.id, a.cookie, 'PATCH', {
          name: meta.name,
          category: 'bank',
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.position.findUniqueOrThrow({ where: { id: p.data.id } })).iconId,
      own.data.id,
    );
    const backup = await call('/backup', a.cookie);
    assert.equal(backup.status, 200);
    assert.equal(
      backup.data.icons.some((i: any) => i.id === own.data.id),
      true,
    );
    assert.doesNotMatch(JSON.stringify(backup.data), /passwordHash|sessionId|ownerId|token/i);
    const broken = structuredClone(backup.data);
    broken.icons[0].image = 'invalid';
    assert.equal((await call('/backup/preview', b.cookie, 'POST', broken)).status, 400);
    const before = await db.icon.count();
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup: broken })).status,
      400,
    );
    assert.equal(await db.icon.count(), before);
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup: backup.data }))
        .status,
      201,
    );
    const imported = await db.position.findMany({
      where: { userId: b.id, importedFromId: { not: null } },
      include: { icon: true },
    });
    assert.equal(imported.length, 2);
    assert.equal(imported[0].iconId, imported[1].iconId);
    assert.equal(imported[0].icon?.ownerId, b.id);
    assert.equal(imported[0].icon?.shared, false);
    // Backup receipt remains valid; only temporary account A is cleared.
    assert.equal(
      (await call('/backup/clear', a.cookie, 'POST', { confirmation: '确定清空' })).status,
      201,
    );
    assert.equal(await db.icon.count({ where: { id: own.data.id } }), 0);
    assert.equal((await call('/icons/' + shared.data.id + '/image', b.cookie)).status, 200);
    assert.equal(
      (await db.position.findUniqueOrThrow({ where: { id: other.data.id } })).iconId,
      shared.data.id,
    );
    assert.equal((await db.icon.count({ where: { ownerId: b.id, shared: false } })) > 0, true);
  } finally {
    const users = await db.user.findMany({
      where: { username: { in: names } },
      select: { id: true },
    });
    await db.icon.deleteMany({
      where: { OR: [{ ownerId: { in: users.map((u) => u.id) } }, { id: { in: publicIds } }] },
    });
    await db.user.deleteMany({ where: { username: { in: names } } });
    await db.$disconnect();
  }
});
