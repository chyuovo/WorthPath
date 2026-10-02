import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { today } from '../src/validation';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('real MySQL: groups, scheduled atomic execution, calendar, privacy and ZIP recovery', async () => {
  const db = new PrismaClient(),
    names: string[] = [];
  const minute = (delta = 0) =>
    new Date(Date.now() + delta + 8 * 3600000).toISOString().slice(0, 16);
  async function call(path: string, cookie = '', method = 'GET', body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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
  async function user() {
    const username = 'wp_update_' + randomUUID(),
      password = randomBytes(18).toString('hex');
    names.push(username);
    const result = await call('/auth/register', '', 'POST', { username, password });
    assert.equal(result.status, 201);
    return {
      cookie: result.cookie,
      password,
      id: (await db.user.findUniqueOrThrow({ where: { username } })).id,
    };
  }
  try {
    const a = await user(),
      b = await user();
    const create = async (name: string, amount: string, groupName: string) => {
      const result = await call('/positions', a.cookie, 'POST', {
        name,
        amount,
        groupName,
        kind: 'account',
        side: 'asset',
        category: 'bank',
        currency: 'CNY',
        date: '2026-09-01T10:00',
      });
      assert.equal(result.status, 201);
      return result.data.id;
    };
    const sourceId = await create('Daily', '10', '日常'),
      targetId = await create('Invest', '0', '理财');
    assert.equal(
      (await call('/positions', a.cookie)).data.find((p: any) => p.id === sourceId).groupName,
      '日常',
    );
    const request = {
      sourceId,
      targetId,
      amount: '25',
      received: '25',
      fee: '0',
      date: minute(),
      requestId: randomUUID(),
    };
    assert.equal((await call('/transfers', a.cookie, 'POST', request)).status, 201);
    assert.equal(
      (await call('/positions', a.cookie)).data.find((p: any) => p.id === sourceId).amount,
      '-15',
    );
    const input = {
      name: 'Rent',
      operation: 'expense',
      sourceId,
      targetId: null,
      amount: '2.5',
      received: '0',
      nextAt: minute(-60000),
      intervalDays: 0,
      notes: '',
    };
    const plan = await call('/schedules', a.cookie, 'POST', input);
    assert.equal(plan.status, 201);
    assert.equal((await call('/schedules', b.cookie)).data.length, 0);
    assert.equal(
      (await call('/schedules/' + plan.data.id, b.cookie, 'PATCH', { enabled: false })).status,
      404,
    );
    const race = await Promise.all([
      call('/schedules/run', a.cookie, 'POST', {}),
      call('/schedules/run', a.cookie, 'POST', {}),
    ]);
    assert.equal(
      race.reduce((n, v) => n + v.data.executed, 0),
      1,
    );
    assert.equal(
      (await call('/positions', a.cookie)).data.find((p: any) => p.id === sourceId).amount,
      '-17.5',
    );
    assert.equal(
      (await call('/schedules/' + plan.data.id, a.cookie, 'PATCH', { enabled: true })).status,
      400,
    );
    assert.equal((await call('/schedules/run', a.cookie, 'POST', {})).data.executed, 0);
    const recurring = await call('/schedules', a.cookie, 'POST', {
      ...input,
      name: 'Daily expense',
      amount: '1',
      intervalDays: 1,
      nextAt: minute(-2 * 86400000),
    });
    assert.equal(recurring.status, 201);
    for (let i = 0; i < 3; i++)
      assert.equal((await call('/schedules/run', a.cookie, 'POST', {})).data.executed, 1);
    assert.equal((await call('/schedules/run', a.cookie, 'POST', {})).data.executed, 0);
    const calendar = await call('/calendar?month=' + today().slice(0, 7), a.cookie);
    const day = calendar.data.items.find((v: any) => v.date === today());
    assert.equal(day.expense, '5.50');
    assert.equal(day.income, '0.00');
    assert.equal((await call('/calendar/day?date=' + today(), a.cookie)).data.items.length, 4);
    const backup = (await call('/backup', a.cookie)).data;
    assert.equal(backup.schedules.length, 2);
    assert.equal(
      (await call('/backup/import', b.cookie, 'POST', { confirmed: true, backup })).status,
      201,
    );
    assert.equal((await call('/schedules/run', b.cookie, 'POST', {})).data.executed, 0);
    assert.deepEqual(
      (await call('/positions', b.cookie)).data.map((v: any) => v.groupName).sort(),
      ['日常', '理财'].sort(),
    );
    const restored = (await call('/backup', b.cookie)).data;
    assert.equal(restored.schedules.filter((p: any) => p.completed).length, 1);
    await call('/positions/' + sourceId, a.cookie, 'PATCH', {
      name: 'Daily',
      category: 'bank',
      groupName: '日常',
      hidden: true,
    });
    assert.equal((await call('/schedules', a.cookie)).data.length, 0);
    assert.equal((await call('/calendar/day?date=' + today(), a.cookie)).data.items.length, 0);
  } finally {
    await db.user.deleteMany({ where: { username: { in: names } } });
    await db.$disconnect();
  }
});
