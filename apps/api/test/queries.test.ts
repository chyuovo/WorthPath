import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { toBusinessDate } from '../src/validation';
import { readBackupZip } from '../src/zip';
const base = process.env.TEST_API_URL || 'http://127.0.0.1:3100/api';
test('bounded APIs preserve seeds, predecessor balances, pagination, archive and FX scope', async () => {
  const db = new PrismaClient();
  const user = await db.user.create({
    data: { username: 'wp_query_' + randomUUID(), passwordHash: 'not-a-login-hash' },
  });
  const token = randomBytes(32).toString('hex'),
    sessionId = createHash('sha256').update(token).digest('hex');
  let restoredUserId: string | undefined;
  async function call(path: string) {
    const response = await fetch(base + path, { headers: { Cookie: 'wp_session=' + token } });
    return { status: response.status, data: await response.json() };
  }
  try {
    await db.session.create({
      data: { id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + 600000) },
    });
    const make = (name: string, currency = 'CNY', hidden = false) =>
      db.position.create({
        data: {
          userId: user.id,
          name,
          currency,
          hidden,
          kind: 'account',
          side: 'asset',
          category: 'bank',
          notes: '',
        },
      });
    const a = await make('archive'),
      b = await make('foreign', 'USD'),
      hidden = await make('hidden', 'CNY', true);
    const revision = (positionId: string, amount: string, date: string) =>
      db.revision.create({
        data: {
          positionId,
          amount,
          effectiveDate: toBusinessDate(date),
          notes: '',
          reason: 'balance',
        },
      });
    await revision(a.id, '100', '2026-08-31T23:59');
    await revision(a.id, '119', '2026-09-02T00:01');
    await revision(a.id, '120', '2026-09-02T00:01');
    await revision(a.id, '110', '2026-09-01T00:01'); // Late insert does not replace the latest balance.
    await revision(b.id, '10', '2026-08-31T23:59');
    await revision(hidden.id, '3', '2026-09-01T00:01');
    await db.position.update({ where: { id: a.id }, data: { archived: true } });
    await db.exchangeRate.create({
      data: {
        userId: user.id,
        currency: 'USD',
        baseCurrency: 'CNY',
        date: new Date('2026-09-02'),
        rate: '7',
        source: 'manual',
      },
    });
    const list = (await call('/positions?kind=account')).data;
    assert.equal(list.length, 2);
    assert.equal(list.find((p: any) => p.id === a.id).amount, '120');
    assert.equal('history' in list[0], false);
    assert.equal('revisions' in list[0], false);
    const current = (await call('/overview')).data;
    assert.equal(current.net, '190.00');
    assert.equal('trend' in current, false);
    const trend = (await call('/trend?from=2026-09-01&to=2026-09-03')).data.items;
    assert.equal(trend[0].complete, false);
    assert.equal(trend[1].net, '190.00');
    assert.equal(trend[1].balanceChange, null);
    assert.equal(trend[2].fxChange, '0.00');
    assert.equal('items' in trend[0], false);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await call(
        '/positions/' + a.id + '/history?limit=1' + (cursor ? '&cursor=' + cursor : ''),
      );
      assert.equal(response.status, 200);
      const row = response.data.items[0];
      assert.equal(seen.has(row.id), false);
      seen.add(row.id);
      if (row.after === '120') {
        assert.equal(row.before, '119');
        assert.equal(row.delta, '1');
      }
      if (row.after === '119') {
        assert.equal(row.before, '110');
        assert.equal(row.delta, '9');
      }
      if (row.after === '110') assert.equal(row.before, '100');
      cursor = response.data.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 4);
    const bounded = (await call('/positions/' + a.id + '/history?from=2026-09-02&to=2026-09-02'))
      .data.items;
    assert.equal(bounded[1].before, '110');
    assert.equal((await call('/history?limit=101')).status, 400);
    assert.equal((await call('/history?cursor=bad')).status, 400);
    assert.equal((await call('/trend?from=2020-01-01&to=2026-09-03')).status, 400);
    assert.equal((await call('/positions/' + hidden.id + '/history')).status, 404);
    await db.session.update({
      where: { id: sessionId },
      data: { revealUntil: new Date(Date.now() + 60000) },
    });
    assert.equal((await call('/overview')).data.net, '193.00');
    await db.user.update({ where: { id: user.id }, data: { baseCurrency: 'USD' } });
    assert.equal((await call('/overview')).data.complete, false);
    await db.exchangeRate.create({
      data: {
        userId: user.id,
        currency: 'CNY',
        baseCurrency: 'USD',
        date: new Date('2026-09-01'),
        rate: '0.1',
        source: 'manual',
      },
    });
    assert.equal((await call('/overview')).data.net, '22.30');
    await db.user.update({ where: { id: user.id }, data: { baseCurrency: 'CNY' } });
    await db.position.update({ where: { id: a.id }, data: { archived: false } });
    const target = await make('discount target');
    await revision(target.id, '0', '2026-09-01T00:00');
    const origin =
      process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
    const transfer = {
      requestId: randomUUID(),
      sourceId: a.id,
      targetId: target.id,
      amount: '100',
      received: '100',
      fee: '-2',
      date: '2026-09-03T00:01',
    };
    const post = async (path: string, body: unknown, cookie = token) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          Cookie: 'wp_session=' + cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await post('/transfers', transfer)).status, 201);
    assert.equal((await post('/transfers', transfer)).status, 201);
    const discounted = (await call('/positions')).data;
    assert.equal(discounted.find((p: any) => p.id === a.id).amount, '22');
    assert.equal(discounted.find((p: any) => p.id === target.id).amount, '100');
    assert.equal(
      (await post('/transfers', { ...transfer, requestId: randomUUID(), fee: '-101' })).status,
      400,
    );
    const exported = await fetch(base + '/backup', { headers: { Cookie: 'wp_session=' + token } });
    assert.equal(exported.status, 200);
    const backup = (await readBackupZip(Buffer.from(await exported.arrayBuffer()))) as any;
    assert.equal(backup.transfers[0].fee, '-2');
    const restored = await db.user.create({
      data: { username: 'wp_query_restore_' + randomUUID(), passwordHash: 'not-a-login-hash' },
    });
    restoredUserId = restored.id;
    const restoredToken = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: createHash('sha256').update(restoredToken).digest('hex'),
        userId: restored.id,
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    assert.equal(
      (await post('/backup/import', { confirmed: true, backup }, restoredToken)).status,
      201,
    );
    const restoredTransfer = await db.transfer.findFirstOrThrow({ where: { userId: restored.id } });
    assert.equal(restoredTransfer.fee.toString(), '-2');
    const restoredBalance = await db.revision.findUniqueOrThrow({
      where: { id: restoredTransfer.sourceRevisionId },
    });
    assert.equal(restoredBalance.amount.toString(), '22');
  } finally {
    if (restoredUserId) await db.user.delete({ where: { id: restoredUserId } });
    await db.user.delete({ where: { id: user.id } });
    await db.$disconnect();
  }
});
