import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { hash } from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('credentials rotate sessions; deleting paired and empty histories preserves ZIP recovery', async () => {
  const db = new PrismaClient(),
    ids: string[] = [];
  const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
  async function call(path: string, cookie = '', method = 'GET', body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get('set-cookie')?.split(';')[0] || '',
    };
  }
  async function session(userId: string) {
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: createHash('sha256').update(token).digest('hex'),
        userId,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return 'wp_session=' + token;
  }
  async function user() {
    const username = 'wp_fix_' + randomUUID(),
      password = randomBytes(18).toString('hex');
    const user = await db.user.create({
      data: { username, passwordHash: await hash(password, 12) },
    });
    ids.push(user.id);
    const cookie = await session(user.id);
    return { id: user.id, username, password, cookie };
  }
  try {
    const a = await user(),
      b = await user();
    const other = { cookie: await session(a.id) };
    assert.equal(
      (
        await call('/auth/credentials', a.cookie, 'PATCH', {
          username: b.username,
          currentPassword: 'wrong-password',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call('/auth/credentials', a.cookie, 'PATCH', {
          username: b.username,
          currentPassword: a.password,
        })
      ).status,
      409,
    );
    assert.equal((await call('/auth/me', other.cookie)).status, 200);
    const username = 'wp_changed_' + randomUUID(),
      password = randomBytes(18).toString('hex');
    const changed = await call('/auth/credentials', a.cookie, 'PATCH', {
      username,
      currentPassword: a.password,
      newPassword: password,
    });
    assert.equal(changed.status, 200);
    a.cookie = changed.cookie;
    assert.equal((await call('/auth/me', other.cookie)).status, 401);
    assert.equal((await call('/auth/me', a.cookie)).data.username, username);
    assert.equal(
      (await call('/auth/login', '', 'POST', { username: a.username, password: a.password }))
        .status,
      401,
    );
    assert.equal(
      (await call('/auth/login', '', 'POST', { username, password: a.password })).status,
      401,
    );
    assert.equal((await call('/auth/login', '', 'POST', { username, password })).status, 201);
    await db.session.updateMany({
      where: { userId: a.id },
      data: { revealUntil: new Date(Date.now() + 300000) },
    });
    assert.equal((await call('/auth/me', a.cookie)).data.revealed, true);
    async function create(name: string, amount: string) {
      const result = await call('/positions', a.cookie, 'POST', {
        name,
        amount,
        kind: 'account',
        side: 'asset',
        category: 'bank',
        currency: 'CNY',
        date: '2026-09-01T00:00',
      });
      assert.equal(result.status, 201);
      return result.data.id;
    }
    const sourceId = await create('source', '100'),
      targetId = await create('target', '0'),
      emptyId = await create('empty', '1');
    const rev = (id: string) =>
      db.revision.findFirstOrThrow({ where: { positionId: id }, orderBy: { sequence: 'asc' } });
    const remove = (id: string, revisionId: string, cookie = a.cookie) =>
      call('/positions/' + id + '/revisions/' + revisionId, cookie, 'DELETE');
    assert.equal((await remove(emptyId, (await rev(emptyId)).id)).status, 200);
    const movement = await call('/transfers', a.cookie, 'POST', {
      sourceId,
      targetId,
      amount: '10',
      received: '10',
      fee: '0',
      date: '2026-09-02T00:00',
    });
    assert.equal(movement.status, 201);
    const pair = await db.transfer.findUniqueOrThrow({ where: { id: movement.data.id } });
    assert.equal((await remove(sourceId, pair.sourceRevisionId, b.cookie)).status, 404);
    assert.equal((await remove(sourceId, (await rev(sourceId)).id)).status, 200);
    assert.equal((await remove(targetId, (await rev(targetId)).id)).status, 200);
    assert.equal(
      (await call('/transfers/revision/' + pair.sourceRevisionId, a.cookie)).data.id,
      pair.id,
    );
    const download = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type')?.includes('application/zip'), true);
    const bytes = Buffer.from(await download.arrayBuffer());
    const backup: any = await readBackupZip(bytes);
    assert.equal(backup.positions.find((p: any) => p.id === emptyId).revisions.length, 0);
    assert.equal(backup.positions.find((p: any) => p.id === sourceId).revisions[0].amount, '-10');
    const form = new FormData();
    form.append('file', new Blob([bytes]), 'backup.zip');
    const upload = await fetch(base + '/backup/upload', {
      method: 'POST',
      headers: { Cookie: b.cookie, Origin: origin },
      body: form,
    });
    assert.equal(upload.status, 201);
    const preview: any = await upload.json();
    assert.equal(
      (
        await call('/backup/import-file', a.cookie, 'POST', {
          token: preview.token,
          confirmed: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call('/backup/import-file', b.cookie, 'POST', {
          token: preview.token,
          confirmed: true,
        })
      ).status,
      201,
    );
    const restored = (await call('/positions', b.cookie)).data;
    assert.equal(restored.find((p: any) => p.name === 'source').amount, '-10');
    assert.equal(restored.find((p: any) => p.name === 'target').amount, '10');
    assert.equal(restored.find((p: any) => p.name === 'empty').amount, '0');
    await db.position.update({ where: { id: targetId }, data: { hidden: true } });
    await call('/auth/lock', a.cookie, 'POST');
    assert.equal((await remove(sourceId, pair.sourceRevisionId)).status, 404);
    assert.equal(await db.transfer.count({ where: { id: pair.id } }), 1);
    await db.session.updateMany({
      where: { userId: a.id },
      data: { revealUntil: new Date(Date.now() + 300000) },
    });
    assert.equal((await remove(sourceId, pair.sourceRevisionId)).status, 200);
    assert.equal(await db.transfer.count({ where: { id: pair.id } }), 0);
    assert.equal(
      await db.revision.count({
        where: { id: { in: [pair.sourceRevisionId, pair.targetRevisionId] } },
      }),
      0,
    );
    assert.equal((await call('/positions/' + sourceId, a.cookie)).data.amount, '0');
    assert.equal((await call('/positions/' + targetId, a.cookie)).data.amount, '0');
    assert.equal((await remove(sourceId, pair.sourceRevisionId)).status, 404);
    const minute = (delta = 0) =>
      new Date(Date.now() + delta + 8 * 3600000).toISOString().slice(0, 16);
    const plan = await call('/schedules', a.cookie, 'POST', {
      name: 'Empty account expense',
      operation: 'expense',
      sourceId,
      targetId: null,
      amount: '2',
      received: '0',
      nextAt: minute(-60000),
      intervalDays: 0,
      notes: '',
    });
    assert.equal(plan.status, 201);
    assert.equal((await call('/schedules/run', a.cookie, 'POST', {})).data.executed, 1);
    const today = minute().slice(0, 10);
    const calendar = (await call('/calendar?month=' + today.slice(0, 7), a.cookie)).data;
    assert.equal(
      calendar.items.find((v: any) => v.date === minute(-60000).slice(0, 10)).expense,
      '2.00',
    );
    assert.equal(
      (
        await call('/transfers', a.cookie, 'POST', {
          sourceId,
          targetId,
          amount: '3',
          received: '3',
          fee: '0',
          date: minute(),
        })
      ).status,
      201,
    );
    const emptyAccountBackup = await fetch(base + '/backup', { headers: { Cookie: a.cookie } });
    assert.equal(emptyAccountBackup.status, 200);
    const emptyAccountData: any = await readBackupZip(
      Buffer.from(await emptyAccountBackup.arrayBuffer()),
    );
    assert.equal(
      emptyAccountData.positions.find((p: any) => p.id === sourceId).revisions.at(-1).amount,
      '-5',
    );
    assert.equal((await call('/backup/preview', b.cookie, 'POST', emptyAccountData)).status, 409);
    const fresh = await user();
    assert.equal(
      (await call('/backup/preview', fresh.cookie, 'POST', emptyAccountData)).status,
      201,
    );
  } finally {
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
