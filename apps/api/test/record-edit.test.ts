import 'reflect-metadata';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/database';
import { TransfersController } from '../src/transfers';
import { PortfolioController } from '../src/portfolio';
import { CalendarController } from '../src/calendar';
import { toBusinessDate } from '../src/validation';

test('record edits replay paired movements, expense deltas, anchors and calendar atomically', async () => {
  const db = new Database();
  const users: string[] = [];
  const movements = new TransfersController(db);
  const portfolio = new PortfolioController(db, {} as any, {} as any);
  const calendar = new CalendarController(db);
  try {
    const user = await db.user.create({
      data: { username: 'wp_edit_' + randomUUID(), passwordHash: 'unused' },
    });
    users.push(user.id);
    const r = { userId: user.id, revealed: false } as any;
    const foreign = { userId: randomUUID(), revealed: false } as any;
    const create = async (amount: string, kind = 'account', side = 'asset') =>
      db.position.create({
        data: {
          userId: user.id,
          name: randomUUID(),
          kind,
          side,
          category: 'other',
          currency: 'CNY',
          notes: '',
          revisions: {
            create: {
              amount,
              effectiveDate: toBusinessDate('2026-09-01T00:00'),
              notes: '',
              reason: 'initial',
            },
          },
        },
        include: { revisions: true },
      });
    const a = await create('100'),
      b = await create('0');
    const input = {
      sourceId: a.id,
      targetId: b.id,
      amount: '20',
      received: '20',
      fee: '2',
      date: '2026-09-02T10:00',
      operation: 'transfer',
      notes: '',
    };
    const transfer = await movements.create(r, input);
    const expense = await db.revision.create({
      data: {
        positionId: a.id,
        amount: '73',
        effectiveDate: toBusinessDate('2026-09-03T10:00'),
        reason: 'scheduled_expense',
        notes: '',
      },
    });
    const later = await movements.create(r, {
      ...input,
      amount: '10',
      received: '10',
      fee: '0',
      date: '2026-09-04T10:00',
    });
    const balance = async (id: string) => (await portfolio.detail(r, id)).amount;
    assert.equal(await balance(a.id), '63');
    await assert.rejects(movements.remove(foreign, transfer.id));
    await assert.rejects(portfolio.deleteRevision(foreign, a.id, a.revisions[0].id));
    await movements.edit(r, transfer.id, { ...input, amount: '30', received: '30', fee: '3' });
    assert.equal(await balance(a.id), '52');
    assert.equal(await balance(b.id), '40');
    assert.equal(
      (await db.revision.findUniqueOrThrow({ where: { id: expense.id } })).amount.toString(),
      '62',
    );
    const month = await calendar.month(r, '2026-09');
    assert.equal(month.items.find((v) => v.date === '2026-09-03')!.expense, '5.00');
    await portfolio.correct(r, a.id, a.revisions[0].id, {
      amount: '200',
      date: '2026-09-01T00:00',
      notes: '',
    });
    assert.equal(await balance(a.id), '152');
    await movements.remove(r, transfer.id);
    assert.equal(await balance(a.id), '185');
    assert.equal(await balance(b.id), '10');
    assert.equal(
      await db.revision.count({
        where: {
          id: {
            in: [
              (await db.transfer.findUniqueOrThrow({ where: { id: later.id } })).sourceRevisionId,
            ],
          },
        },
      }),
      1,
    );
    await portfolio.correct(r, a.id, expense.id, {
      amount: '193',
      date: '2026-09-03T10:00',
      notes: '',
    });
    assert.equal(await balance(a.id), '183');
    assert.equal(
      (await calendar.month(r, '2026-09')).items.find((v) => v.date === '2026-09-03')!.expense,
      '7.00',
    );
    await portfolio.deleteRevision(r, a.id, expense.id);
    assert.equal(await balance(a.id), '190');
    assert.equal((await calendar.day(r, '2026-09-03')).items.length, 0);
    await portfolio.deleteRevision(r, a.id, a.revisions[0].id);
    assert.equal(await balance(a.id), '-10');
    const restoredInitial = await db.revision.create({
      data: {
        positionId: a.id,
        amount: '200',
        effectiveDate: toBusinessDate('2026-09-01T00:00'),
        reason: 'initial',
        notes: '',
      },
    });
    a.revisions[0].id = restoredInitial.id;
    // Replay after restoring a baseline through the correction API.
    await portfolio.correct(r, a.id, restoredInitial.id, {
      amount: '200',
      date: '2026-09-01T00:00',
      notes: '',
    });
    assert.equal(await balance(a.id), '190');
    // An observed absolute balance is an anchor, including after a moved transfer.
    await portfolio.revise(r, a.id, {
      amount: '300',
      date: '2026-09-05T00:00',
      reason: 'balance',
      notes: '',
    });
    await movements.edit(r, later.id, {
      ...input,
      amount: '15',
      received: '15',
      fee: '0',
      date: '2026-09-02T00:00',
    });
    assert.equal(await balance(a.id), '300');
    assert.equal(await balance(b.id), '15');
    const initial = a.revisions[0].id;
    await db.position.update({ where: { id: a.id }, data: { hidden: true } });
    await assert.rejects(movements.remove(r, later.id));
    await assert.rejects(
      portfolio.correct(r, a.id, initial, { amount: '1', date: '2026-09-01T00:00', notes: '' }),
    );
    await db.position.update({ where: { id: a.id }, data: { hidden: false } });
    const debt = await create('20', 'debt', 'liability');
    const repayment = await movements.create(r, {
      ...input,
      targetId: debt.id,
      amount: '10',
      received: '10',
      fee: '0',
      operation: 'repay',
      date: '2026-09-06T00:00',
    });
    await assert.rejects(
      movements.edit(r, repayment.id, {
        ...input,
        targetId: debt.id,
        amount: '25',
        received: '25',
        fee: '0',
        operation: 'repay',
        date: '2026-09-06T00:00',
      }),
    );
    assert.equal(await balance(debt.id), '10');
    assert.equal(await balance(a.id), '290');
    await movements.remove(r, repayment.id);
    assert.equal(await balance(debt.id), '20');
    assert.equal(await balance(a.id), '300');
    // Cross-currency values and signed fees retain exact decimal precision.
    await db.position.update({ where: { id: b.id }, data: { currency: 'USD' } });
    const fx = await movements.create(r, {
      ...input,
      amount: '0.12435678',
      received: '0.01423567',
      fee: '-0.00000001',
      date: '2026-09-07T00:00',
    });
    await movements.edit(r, fx.id, {
      ...input,
      amount: '0.22345678',
      received: '0.02234567',
      fee: '-0.00000002',
      date: '2026-09-07T00:00',
    });
    assert.equal(await balance(a.id), '299.77654324');
    assert.equal(await balance(b.id), '15.02234567');
    await movements.remove(r, fx.id);
    assert.equal(await balance(a.id), '300');
    assert.equal(await balance(b.id), '15');
  } finally {
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
