// Run HTTP integration tests against a disposable MySQL database and API process.
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { mkdtempSync, rmSync } = require('node:fs');
const { join, resolve, dirname, basename } = require('node:path');
const { tmpdir } = require('node:os');
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
  let iconDirectory;
  try {
    await connection.query('CREATE DATABASE `' + name + '`');
    url.pathname = '/' + name;
    iconDirectory = mkdtempSync(join(tmpdir(), 'wp_test_icons_'));
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
      ICON_STORAGE_DIR: iconDirectory,
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
    const migration = run([require.resolve('./database.cjs'), 'deploy']);
    if (migration.status !== 0) {
      const safe = (migration.stdout + migration.stderr)
        .split(/\r?\n/)
        .filter((line) => !/Datasource|mysql:\/\/|DATABASE_URL|Environment variables/.test(line))
        .join('\n');
      console.error(safe);
      throw Error('Disposable database migration failed');
    }
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
          'test/database-migrations.test.ts',
          'test/connection-repayment-integration.test.ts',
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
    if (
      iconDirectory &&
      dirname(resolve(iconDirectory)) === resolve(tmpdir()) &&
      basename(iconDirectory).startsWith('wp_test_icons_')
    )
      rmSync(iconDirectory, { recursive: true, force: true });
    console.log('Disposable test database and API cleaned up.');
  }
}
main().catch((e) => {
  console.error(
    'Isolated test run failed: ' +
      (/Disposable|API build/.test(e.message)
        ? e.message
        : 'check test configuration or database access (' + (e.code || e.name) + ')'),
  );
  process.exitCode = 1;
});
