require('dotenv').config({ quiet: true });
const { spawnSync } = require('node:child_process');
const { mkdtempSync, copyFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, resolve, dirname, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');

// Preserve historical names and SQL. Deploy their prerequisites first on a new database.
const initialMigrations = [
  '202610010001_initial',
  '202610010002_import_origin',
  '202610010003_revision_sequence',
  '202610010004_privacy_time_settings',
];
const schema = resolve(__dirname, '../prisma/schema.prisma');
const migrations = resolve(__dirname, '../prisma/migrations');
function bootstrapPlan(tables, history) {
  const applied = new Set(
    history.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name),
  );
  const failed = history.filter((r) => !r.finished_at && !r.rolled_back_at);
  const businessTables = tables.filter((name) => name.toLowerCase() !== '_prisma_migrations');
  const recover =
    failed.length === 1 &&
    failed[0].migration_name === '005_account_icons' &&
    Number(failed[0].applied_steps_count) === 0 &&
    /1824/.test(failed[0].logs || '') &&
    /Failed to open the referenced table/i.test(failed[0].logs || '') &&
    businessTables.length === 0 &&
    applied.size === 0;
  if (failed.length && !recover)
    throw new Error(
      'Unresolved migration requires manual recovery; no database reset was performed.',
    );
  if (initialMigrations.every((name) => applied.has(name)))
    return { bootstrap: false, recover: false };
  const prefix = initialMigrations.slice(0, applied.size);
  if (
    [...applied].some((name) => !prefix.includes(name)) ||
    (businessTables.length && !applied.size)
  )
    throw new Error('Unrecognized partial schema/history; no bootstrap or reset was performed.');
  return { bootstrap: true, recover };
}
function runPrisma(args) {
  const p = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), ...args], {
    encoding: 'utf8',
  });
  const output = (p.stdout || '')
    .split(/\r?\n/)
    .filter((s) => !s.startsWith('Datasource ') && !s.includes('Environment variables'))
    .join('\n');
  if (p.status === 0) {
    if (output.trim()) console.log(output);
  } else {
    const codes = [...new Set(((p.stdout || '') + (p.stderr || '')).match(/P\d{4}/g) || [])];
    console.error(
      'Prisma command failed' +
        (codes.length ? ': ' + codes.join(', ') : '') +
        '. No database reset was performed.',
    );
  }
  return p.status === 0 ? 0 : p.status || 1;
}
async function deploy() {
  const url = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !database) throw new Error('Invalid MySQL configuration.');
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    charset: 'utf8mb4',
    connectTimeout: 10000,
  });
  const lock =
    'worthpath:migrate:' +
    createHash('sha256').update(database.toLowerCase()).digest('hex').slice(0, 32);
  let locked = false,
    folder;
  try {
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
    if (Number(lockRows[0].acquired) !== 1) throw new Error('Migration lock is busy; retry later.');
    locked = true;
    const [rows] = await connection.execute(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
      [database],
    );
    const tables = rows.map((r) => r.TABLE_NAME);
    const quotedDatabase = '`' + database.replace(/`/g, '``') + '`';
    const [history] = tables.some((name) => name.toLowerCase() === '_prisma_migrations')
      ? await connection.query(
          'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, logs FROM ' +
            quotedDatabase +
            '.`_prisma_migrations`',
        )
      : [[]];
    const plan = bootstrapPlan(tables, history);
    if (plan.recover) {
      console.log('Verified empty database: recovering the failed 005_account_icons attempt.');
      const status = runPrisma([
        'migrate',
        'resolve',
        '--rolled-back',
        '005_account_icons',
        '--schema',
        schema,
      ]);
      if (status) return status;
    }
    if (plan.bootstrap) {
      folder = mkdtempSync(join(tmpdir(), 'worthpath-migrations-'));
      copyFileSync(schema, join(folder, 'schema.prisma'));
      mkdirSync(join(folder, 'migrations'));
      copyFileSync(
        join(migrations, 'migration_lock.toml'),
        join(folder, 'migrations/migration_lock.toml'),
      );
      for (const name of initialMigrations) {
        mkdirSync(join(folder, 'migrations', name));
        copyFileSync(
          join(migrations, name, 'migration.sql'),
          join(folder, 'migrations', name, 'migration.sql'),
        );
      }
      console.log('Deploying initial prerequisites before historical 005-007 migrations.');
      const status = runPrisma(['migrate', 'deploy', '--schema', join(folder, 'schema.prisma')]);
      if (status) return status;
    }
    return runPrisma(['migrate', 'deploy', '--schema', schema]);
  } finally {
    if (
      folder &&
      dirname(resolve(folder)) === resolve(tmpdir()) &&
      basename(folder).startsWith('worthpath-migrations-')
    )
      rmSync(folder, { recursive: true, force: true });
    if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [lock]);
    await connection.end();
  }
}
module.exports = { bootstrapPlan, initialMigrations };
if (require.main === module) {
  const command = process.argv[2];
  if (command === 'status') process.exitCode = runPrisma(['migrate', 'status', '--schema', schema]);
  else if (command === 'deploy')
    deploy()
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        const safe = /^(Unresolved migration|Unrecognized partial|Migration lock)/.test(
          error.message,
        )
          ? error.message
          : 'Database migration command failed. Check configuration and database access. No reset was performed.';
        console.error(safe);
        process.exitCode = 1;
      });
  else process.exitCode = 1;
}
