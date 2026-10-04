import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioBusinessService } from '../src/portfolio';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
function fixture() {
  const row = { id: 'account', userId: 'owner', name: '测试账户', kind: 'account', hidden: false };
  let movements = 0,
    schedules = 0,
    deleted = false,
    invalidated = false;
  const db: any = {
    serial: async (fn: any) => fn(db),
    $queryRaw: async () => [],
    position: {
      findFirst: async ({ where }: any) =>
        where.id === row.id &&
        where.userId === row.userId &&
        !(where.hidden === false && row.hidden) &&
        !deleted
          ? row
          : null,
      delete: async () => {
        deleted = true;
        return row;
      },
    },
    transfer: { count: async () => movements },
    schedule: { count: async () => schedules },
  };
  const service = new PortfolioBusinessService(
    db,
    {
      invalidate: () => {
        invalidated = true;
      },
    } as any,
    {} as any,
    {} as any,
  );
  return {
    service,
    row,
    setMovements: (v: number) => {
      movements = v;
    },
    setSchedules: (v: number) => {
      schedules = v;
    },
    state: () => ({ deleted, invalidated }),
  };
}
const owner = { userId: 'owner', revealed: false } as any;
test('account deletion checks ownership and hidden visibility before deleting or invalidating', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.service.remove({ ...owner, userId: 'other' }, 'account', { confirmation: '测试账户' }),
    NotFoundException,
  );
  f.row.hidden = true;
  await assert.rejects(
    () => f.service.remove(owner, 'account', { confirmation: '测试账户' }),
    NotFoundException,
  );
  assert.deepEqual(f.state(), { deleted: false, invalidated: false });
  await f.service.remove({ ...owner, revealed: true }, 'account', { confirmation: '测试账户' });
  assert.deepEqual(f.state(), { deleted: true, invalidated: true });
});
test('wrong confirmation, paired movements and schedules cannot cascade', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.service.remove(owner, 'account', { confirmation: '错误名称' }),
    BadRequestException,
  );
  f.setMovements(1);
  await assert.rejects(
    () => f.service.remove(owner, 'account', { confirmation: '测试账户' }),
    ConflictException,
  );
  f.setMovements(0);
  f.setSchedules(1);
  await assert.rejects(
    () => f.service.remove(owner, 'account', { confirmation: '测试账户' }),
    ConflictException,
  );
  assert.deepEqual(f.state(), { deleted: false, invalidated: false });
  f.setSchedules(0);
  assert.deepEqual(await f.service.remove(owner, 'account', { confirmation: '测试账户' }), {
    ok: true,
  });
  assert.deepEqual(f.state(), { deleted: true, invalidated: true });
});

test('standalone assets and debts support deletion and invalidate totals', async () => {
  for (const kind of ['asset', 'debt']) {
    const f = fixture();
    f.row.kind = kind;
    assert.deepEqual(await f.service.remove(owner, 'account', { confirmation: '测试账户' }), {
      ok: true,
    });
    assert.deepEqual(f.state(), { deleted: true, invalidated: true });
  }
});
