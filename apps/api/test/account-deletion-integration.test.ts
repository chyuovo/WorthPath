import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { today } from '../src/validation';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
test('real REST account deletion preserves paired balances, blocks schedules, cascades own history and isolates users', async () => {
  const db = new PrismaClient(),
    users: string[] = [];
  async function fixture() {
    const u = await db.user.create({
      data: { username: 'delete_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    users.push(u.id);
    const token = randomBytes(32).toString('hex');
    const sessionId = createHash('sha256').update(token).digest('hex');
    await db.session.create({
      data: { id: sessionId, userId: u.id, expiresAt: new Date(Date.now() + 3600000) },
    });
    return { id: u.id, cookie: 'wp_session=' + token, sessionId };
  }
  async function call(u: any, path: string, method = 'GET', data?: unknown) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Cookie: u.cookie,
        Origin: origin,
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    const a = await fixture(),
      b = await fixture();
    const input = {
      kind: 'account',
      side: 'asset',
      category: 'cash',
      name: '删除测试账户',
      currency: 'CNY',
      amount: '100',
      date: today(),
    };
    const first = await call(a, '/positions', 'POST', input);
    assert.equal(first.status, 201);
    const id = first.data.id;
    assert.equal((await call(b, '/positions/' + id + '/deletion')).status, 404);
    assert.equal(
      (await call(b, '/positions/' + id, 'DELETE', { confirmation: input.name })).status,
      404,
    );
    assert.equal(
      (await call(a, '/positions/' + id, 'DELETE', { confirmation: '错误名称' })).status,
      400,
    );
    assert.equal(
      (
        await call(a, '/positions/' + id + '/revisions', 'POST', {
          amount: '125.87654321',
          date: today(),
        })
      ).status,
      201,
    );
    const debt = await call(a, '/positions', 'POST', {
      ...input,
      kind: 'debt',
      side: 'liability',
      name: '关联债务',
      amount: '10',
    });
    assert.equal(debt.status, 201);
    assert.equal(
      (await call(a, '/positions/' + debt.data.id + '/links', 'PUT', { targetIds: [id] })).status,
      200,
    );
    const impact = await call(a, '/positions/' + id + '/deletion');
    assert.equal(impact.data.historyCount, 2);
    assert.equal(impact.data.linkCount, 1);
    assert.equal(impact.data.canDelete, true);
    assert.equal(
      (await call(a, '/positions/' + id, 'DELETE', { confirmation: input.name })).status,
      200,
    );
    assert.equal((await call(a, '/positions/' + id)).status, 404);
    assert.equal(await db.revision.count({ where: { positionId: id } }), 0);
    assert.equal(await db.positionLink.count({ where: { targetId: id } }), 0);
    const overview = await call(a, '/overview');
    assert.equal(overview.data.assets, '0.00');
    assert.equal(overview.data.liabilities, '10.00');
    assert.ok(!(await call(a, '/history')).data.items.some((h: any) => h.positionId === id));
    assert.ok(
      !(await call(a, '/calendar/day?date=' + today())).data.items.some(
        (h: any) => h.positionId === id,
      ),
    );

    const source = (await call(a, '/positions', 'POST', input)).data.id;
    const target = (
      await call(a, '/positions', 'POST', { ...input, name: '收款测试账户', amount: '0' })
    ).data.id;
    const movement = await call(a, '/transfers', 'POST', {
      sourceId: source,
      targetId: target,
      amount: '20',
      received: '20',
      date: today(),
    });
    assert.equal(movement.status, 201);
    assert.equal((await call(a, '/positions/' + source + '/deletion')).data.canDelete, false);
    assert.equal(
      (await call(a, '/positions/' + source, 'DELETE', { confirmation: input.name })).status,
      409,
    );
    assert.equal((await call(a, '/positions/' + target)).data.amount, '20');
    assert.equal((await call(a, '/transfers/' + movement.data.id, 'DELETE')).status, 200);
    assert.equal((await call(a, '/positions/' + target)).data.amount, '0');
    const schedule = await call(a, '/schedules', 'POST', {
      name: '未来计划',
      operation: 'expense',
      sourceId: source,
      amount: '5',
      nextAt: '2099-01-01T10:00',
      intervalDays: 0,
    });
    assert.equal(schedule.status, 201);
    assert.equal((await call(a, '/positions/' + source + '/deletion')).data.scheduleCount, 1);
    assert.equal(
      (await call(a, '/positions/' + source, 'DELETE', { confirmation: input.name })).status,
      409,
    );
    assert.equal((await call(a, '/schedules/' + schedule.data.id, 'DELETE')).status, 200);
    assert.equal(
      (await call(a, '/positions/' + source, 'DELETE', { confirmation: input.name })).status,
      200,
    );

    const hidden = (await call(a, '/positions', 'POST', { ...input, hidden: true })).data.id;
    assert.equal((await call(a, '/positions/' + hidden + '/deletion')).status, 404);
    assert.equal(
      (await call(a, '/positions/' + hidden, 'DELETE', { confirmation: input.name })).status,
      404,
    );
    await db.session.update({
      where: { id: a.sessionId },
      data: { revealUntil: new Date(Date.now() + 600000) },
    });
    assert.equal(
      (await call(a, '/positions/' + hidden, 'DELETE', { confirmation: input.name })).status,
      200,
    );
    assert.equal(
      (await call(a, '/positions/' + debt.data.id, 'DELETE', { confirmation: '关联债务' })).status,
      200,
    );
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
test('draft review resolves only referenced visible names and canonical standalone confirmation URL', async () => {
  const db = new PrismaClient();
  let userId = '';
  try {
    const u = await db.user.create({
      data: { username: 'review_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    userId = u.id;
    const token = randomBytes(32).toString('hex'),
      sid = createHash('sha256').update(token).digest('hex');
    await db.session.create({
      data: { id: sid, userId, expiresAt: new Date(Date.now() + 3600000) },
    });
    const grant = await db.agentGrant.create({
      data: {
        userId,
        name: '草稿审阅测试',
        scopes: ['read', 'draft'],
        resource: process.env.MCP_PUBLIC_URL || 'http://localhost:3100/mcp',
        sessionId: sid,
        accessDigest: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const visible = await db.position.create({
      data: {
        userId,
        name: '可见账户',
        kind: 'account',
        side: 'asset',
        category: 'cash',
        currency: 'CNY',
        notes: '',
      },
    });
    const hidden = await db.position.create({
      data: {
        userId,
        name: '隐藏名称不能泄露',
        hidden: true,
        kind: 'account',
        side: 'asset',
        category: 'cash',
        currency: 'CNY',
        notes: '',
      },
    });
    const unrelated = await db.position.create({
      data: {
        userId,
        name: '无关账户',
        kind: 'account',
        side: 'asset',
        category: 'cash',
        currency: 'CNY',
        notes: '',
      },
    });
    const op = await db.agentOperation.create({
      data: {
        userId,
        grantId: grant.id,
        key: randomUUID(),
        hash: '0'.repeat(64),
        snapshot: '0'.repeat(64),
        tool: 'debt_links_set',
        parameters: { id: visible.id, targetIds: [hidden.id] },
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const res = await fetch(base + '/agent/operations/' + op.id, {
      headers: { Cookie: 'wp_session=' + token },
    });
    assert.equal(res.status, 200);
    const preview = await res.json();
    assert.equal(preview.connectionName, '草稿审阅测试');
    assert.equal(preview.impact.references[visible.id].name, '可见账户');
    assert.ok(!preview.impact.references[hidden.id]);
    assert.ok(!preview.impact.references[unrelated.id]);
    assert.equal(new URL(preview.confirmationUrl).pathname, '/agent/operation');
  } finally {
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});

test('standalone asset and both debt sides delete history and links; paired debts preserve account balances', async () => {
  const db = new PrismaClient();
  let userId = '';
  try {
    const u = await db.user.create({
      data: { username: 'delete_position_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    userId = u.id;
    const token = randomBytes(32).toString('hex'),
      sid = createHash('sha256').update(token).digest('hex');
    await db.session.create({
      data: { id: sid, userId, expiresAt: new Date(Date.now() + 3600000) },
    });
    async function call(path: string, method = 'GET', data?: unknown) {
      const r = await fetch(base + path, {
        method,
        headers: {
          Cookie: 'wp_session=' + token,
          Origin: origin,
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: r.status, data: await r.json() };
    }
    async function create(
      name: string,
      kind: string,
      side: string,
      amount: string,
      hidden = false,
    ) {
      const r = await call('/positions', 'POST', {
        name,
        kind,
        side,
        amount,
        hidden,
        currency: 'CNY',
        category: 'other',
        date: today(),
      });
      assert.equal(r.status, 201);
      return r.data.id as string;
    }
    const cash = await create('关联测试账户', 'account', 'asset', '100');
    const asset = await create('独立资产删除测试', 'asset', 'asset', '42');
    const owed = await create('欠款删除测试', 'debt', 'liability', '10');
    const lent = await create('借出删除测试', 'debt', 'asset', '5');
    assert.equal(
      (await call('/positions/' + owed + '/links', 'PUT', { targetIds: [asset, cash] })).status,
      200,
    );
    assert.equal((await call('/positions/' + asset + '/deletion')).data.linkCount, 1);
    assert.equal(
      (await call('/positions/' + asset, 'DELETE', { confirmation: '独立资产删除测试' })).status,
      200,
    );
    assert.equal(await db.revision.count({ where: { positionId: asset } }), 0);
    assert.equal(await db.positionLink.count({ where: { targetId: asset } }), 0);
    assert.equal((await call('/positions/' + owed)).data.amount, '10');
    assert.equal((await call('/overview')).data.assets, '105.00');
    assert.equal(
      (await call('/positions/' + lent, 'DELETE', { confirmation: '借出删除测试' })).status,
      200,
    );
    assert.equal((await call('/overview')).data.assets, '100.00');
    const makeMovement = async (operation: string, amount: string) => {
      const r = await call('/transfers', 'POST', {
        operation,
        sourceId: cash,
        targetId: owed,
        amount,
        received: amount,
        fee: '0',
        date: today(),
        requestId: randomUUID(),
      });
      assert.equal(r.status, 201);
      return r.data.id as string;
    };
    const borrowed = await makeMovement('borrow', '20');
    const repayment = await makeMovement('repay', '5');
    assert.equal((await call('/positions/' + owed + '/deletion')).data.movementCount, 2);
    assert.equal(
      (await call('/positions/' + owed, 'DELETE', { confirmation: '欠款删除测试' })).status,
      409,
    );
    assert.equal((await call('/positions/' + cash)).data.amount, '115');
    assert.equal((await call('/positions/' + owed)).data.amount, '25');
    assert.equal((await call('/transfers/' + repayment, 'DELETE')).status, 200);
    assert.equal((await call('/transfers/' + borrowed, 'DELETE')).status, 200);
    assert.equal((await call('/positions/' + cash)).data.amount, '100');
    assert.equal(
      (await call('/positions/' + owed, 'DELETE', { confirmation: '欠款删除测试' })).status,
      200,
    );
    assert.equal(await db.revision.count({ where: { positionId: owed } }), 0);
    assert.equal(await db.positionLink.count({ where: { sourceId: owed } }), 0);
    assert.equal((await call('/overview')).data.liabilities, '0.00');
    assert.ok(
      !(await call('/history')).data.items.some((h: any) =>
        [asset, lent, owed].includes(h.positionId),
      ),
    );
    assert.ok(
      !(await call('/calendar/day?date=' + today())).data.items.some((h: any) =>
        [asset, lent, owed].includes(h.positionId),
      ),
    );
    for (const [kind, side] of [
      ['asset', 'asset'],
      ['debt', 'liability'],
    ]) {
      const name = '隐藏归档删除-' + kind,
        id = await create(name, kind, side, '3', true);
      await db.position.update({ where: { id }, data: { archived: true } });
      assert.equal((await call('/positions/' + id + '/deletion')).status, 404);
      assert.equal((await call('/positions/' + id, 'DELETE', { confirmation: name })).status, 404);
      await db.session.update({
        where: { id: sid },
        data: { revealUntil: new Date(Date.now() + 600000) },
      });
      assert.equal((await call('/positions/' + id + '/deletion')).data.canDelete, true);
      assert.equal(
        (await call('/positions/' + id, 'DELETE', { confirmation: '错误名称' })).status,
        400,
      );
      assert.equal((await call('/positions/' + id, 'DELETE', { confirmation: name })).status, 200);
      await db.session.update({ where: { id: sid }, data: { revealUntil: null } });
    }
  } finally {
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});
