import { test } from 'node:test';
import assert from 'node:assert/strict';
const { bootstrapPlan, initialMigrations } = require('../scripts/database.cjs');
const applied = (name: string) => ({ migration_name: name, finished_at: new Date() });
const failure = {
  migration_name: '005_account_icons',
  applied_steps_count: 0,
  logs: "Database error code: 1824\nFailed to open the referenced table 'user'",
};
test('bootstrap accepts empty databases and prerequisite prefixes; preserves applied histories', () => {
  assert.deepEqual(bootstrapPlan([], []), { bootstrap: true, recover: false });
  assert.deepEqual(bootstrapPlan(['_prisma_migrations'], [failure]), {
    bootstrap: true,
    recover: true,
  });
  assert.deepEqual(bootstrapPlan(['User'], [applied(initialMigrations[0])]), {
    bootstrap: true,
    recover: false,
  });
  assert.deepEqual(
    bootstrapPlan(['User'], [...initialMigrations.map(applied), applied('005_account_icons')]),
    { bootstrap: false, recover: false },
  );
});
test('bootstrap refuses unknown failures, partially applied SQL and untracked schemas', () => {
  for (const row of [
    { ...failure, migration_name: '006_navigation_transfers' },
    { ...failure, logs: 'Other database error' },
    { ...failure, applied_steps_count: 1 },
  ])
    assert.throws(() => bootstrapPlan([], [row]), /manual recovery/);
  assert.throws(() => bootstrapPlan(['Icon'], [failure]), /manual recovery/);
  assert.throws(() => bootstrapPlan(['User'], []), /Unrecognized/);
  assert.throws(() => bootstrapPlan(['User'], [applied(initialMigrations[1])]), /Unrecognized/);
  assert.throws(
    () => bootstrapPlan(['User'], [...initialMigrations.map(applied), failure]),
    /manual recovery/,
  );
});
