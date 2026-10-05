// Run HTTP integration tests against a disposable MySQL database and API process.
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const name = 'wp_test_' + randomBytes(8).toString('hex');
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  let api;
  try {
    await connection.query('CREATE DATABASE `' + name + '`');
    url.pathname = '/' + name;
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin',
      PORT: String(port),
      API_HOST: '127.0.0.1',
      API_ALLOWED_HOSTS: '*',
      WEB_ORIGIN: 'http://localhost:5173',
      NETWORK_RATE_LIMIT_ENABLED: 'false',
      MCP_PUBLIC_URL: 'http://127.0.0.1:' + port + '/mcp',
      MCP_WEB_URL: 'http://localhost:5173',
      NETWORK_ALLOW_HTTP: 'true',
      TEST_API_URL: 'http://127.0.0.1:' + port + '/api',
    };
    const run = (args) => spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    // Historical 005-007 directories sort before the initial migration. Use the
    // current schema only in this disposable database, then exercise our SQL.
    const migration = run([
      require.resolve('prisma/build/index.js'),
      'db',
      'push',
      '--skip-generate',
    ]);
    if (migration.status !== 0) {
      const safe = (migration.stdout + migration.stderr)
        .split(/\r?\n/)
        .filter((line) => !/Datasource|mysql:\/\/|DATABASE_URL|Environment variables/.test(line))
        .join('\n');
      console.error(safe);
      throw Error('Disposable database migration failed');
    }
    await connection.query('USE `' + name + '`');
    // db push omits the historical column comments asserted by integration tests.
    await connection.query(
      "ALTER TABLE `User` MODIFY COLUMN `accountGroupOrder` JSON NULL COMMENT '账户分组显示顺序；空值表示沿用默认顺序'",
    );
    await connection.query(
      'ALTER TABLE `User` DROP COLUMN `role`, DROP COLUMN `banned`, DROP COLUMN `mustChangePassword`',
    );
    await connection.query(
      fs.readFileSync(
        path.join(__dirname, '../prisma/migrations/20261005130000_admin_accounts/migration.sql'),
        'utf8',
      ),
    );
    // Verify the icon column removal migration against its former shape too.
    await connection.query('ALTER TABLE `Icon` ADD COLUMN `source` VARCHAR(500) NULL');
    await connection.query(
      fs.readFileSync(
        path.join(
          __dirname,
          '../prisma/migrations/20261005150000_remove_icon_source/migration.sql',
        ),
        'utf8',
      ),
    );
    const build = run([require.resolve('typescript/bin/tsc')]);
    if (build.status !== 0) {
      console.log(build.stdout);
      throw Error('API build failed');
    }
    api = spawn(process.execPath, ['dist/main.js'], { env, stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try {
        ready = (await fetch(env.TEST_API_URL + '/health')).ok;
      } catch {}
      if (ready) break;
      if (api.exitCode !== null) throw Error('Disposable API startup failed');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw Error('Disposable API startup timed out');
    env.TEST_ISOLATED = 'true';
    const requested = process.argv.slice(2);
    const tests = requested.length
      ? requested
      : [
          ...pkg.scripts['test:integration'].split(' ').filter((s) => s.endsWith('.test.ts')),
          'test/admin-integration.test.ts',
          'test/mcp.test.ts',
          'test/oauth-duration.test.ts',
        ];
    const result = spawnSync(
      process.execPath,
      [require.resolve('tsx/cli'), '--test', '--test-concurrency=1', ...tests],
      { env, stdio: 'inherit' },
    );
    process.exitCode = result.status || 0;
  } finally {
    if (api && api.exitCode === null) {
      const exited = new Promise((resolve) => api.once('exit', resolve));
      api.kill();
      await exited;
    }
    await connection.query('DROP DATABASE `' + name + '`');
    await connection.end();
    console.log('Disposable test database and API cleaned up.');
  }
}
main().catch((e) => {
  console.error(
    'Isolated test run failed: ' +
      (/Disposable|API build/.test(e.message)
        ? e.message
        : 'check test configuration or database access'),
  );
  process.exitCode = 1;
});
