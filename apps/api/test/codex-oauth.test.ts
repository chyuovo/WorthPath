import { provisionTestUser } from './user-fixture';
import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { today } from '../src/validation';

// Optional real installed-client check; never uses the user's Codex credentials.
for (const useDefaultScopes of [false, true])
  test(
    'Codex OAuth ' +
      (useDefaultScopes ? 'default metadata scopes' : 'explicit scopes') +
      ' are narrowed to draft without hidden access or direct posting',
    async () => {
      const resource = process.env.MCP_PUBLIC_URL || 'http://localhost:3100/mcp';
      const root = process.env.TEST_API_URL?.replace(/\/api$/, '') || 'http://127.0.0.1:3100';
      const origin =
        process.env.WEB_ORIGIN && process.env.WEB_ORIGIN !== '*'
          ? process.env.WEB_ORIGIN
          : 'http://localhost:5173';
      const db = new PrismaClient();
      const home = await mkdtemp(join(tmpdir(), 'worthpath-codex-scope-'));
      const username = 'codex_scope_' + randomUUID().slice(0, 12),
        password = randomBytes(20).toString('hex');
      let userId = '',
        clientId = '',
        cli: ChildProcessWithoutNullStreams | undefined;
      const client = new Client({ name: 'Codex OAuth grant verification', version: '1.31.0' });
      async function web(path: string, body: unknown, cookie = '') {
        const r = await fetch(root + '/api' + path, {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(body),
        });
        assert.equal(r.status, 201, 'Web request failed: ' + path);
        return {
          data: await r.json(),
          cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie,
        };
      }
      async function deadline<T>(promise: Promise<T>, label: string) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              timer = setTimeout(() => reject(Error(label + ' timed out')), 30000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      try {
        await provisionTestUser({ username, password });
        const fixture = await web('/auth/login', { username, password });
        userId = (await db.user.findUniqueOrThrow({ where: { username } })).id;
        await writeFile(
          join(home, 'config.toml'),
          'mcp_oauth_credentials_store = "file"\n[mcp_servers.worthpath]\nurl = ' +
            JSON.stringify(resource) +
            '\n',
        );
        cli = spawn(
          process.env.CODEX_CLI || 'codex',
          [
            'mcp',
            'login',
            'worthpath',
            '--no-browser',
            ...(useDefaultScopes ? [] : ['--scopes', 'read,draft']),
            '--oauth-client-registration',
            'dcr',
          ],
          {
            env: { ...process.env, CODEX_HOME: home },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        const processExit = new Promise<number | null>((resolve, reject) => {
          cli!.on('exit', resolve);
          cli!.on('error', reject);
        });
        // Observe the exit from the start so spawn errors never become unhandled promises.
        void processExit.catch(() => {});
        const authorization = await deadline(
          new Promise<string>((resolve, reject) => {
            let output = '';
            const receive = (chunk: Buffer) => {
              output += chunk.toString();
              const found = output.match(/https?:\/\/[^\s]+\/authorize\?[^\s]+/);
              if (found) resolve(found[0]);
            };
            cli!.stdout.on('data', receive);
            cli!.stderr.on('data', receive);
            cli!.on('error', reject);
            cli!.on('exit', () => reject(Error('CLI exited before authorization URL')));
          }),
          'CLI authorization URL',
        );
        const request = new URL(authorization);
        assert.equal(request.origin, new URL(resource).origin);
        const requested = (request.searchParams.get('scope') || '').split(' ').filter(Boolean);
        assert.deepEqual(
          requested,
          useDefaultScopes
            ? ['read', 'draft', 'write', 'hidden_read', 'hidden_write']
            : ['read', 'draft'],
        );
        clientId = request.searchParams.get('client_id')!;
        const redirect = await fetch(request, { redirect: 'manual' });
        assert.equal(redirect.status, 302);
        const id = new URL(redirect.headers.get('location')!).searchParams.get(
          'agent_authorization',
        );
        assert.ok(id);
        // Isolated disposable fixture only. Real users complete consent in the website.
        const consent = await web(
          '/agent/authorizations/' + id,
          { approve: true, scopes: ['read', 'draft'] },
          fixture.cookie,
        );
        cli.stdin.write(consent.data.redirect + '\n');
        cli.stdin.end();
        assert.equal(await deadline(processExit, 'CLI callback'), 0);
        let access = '';
        const find = (value: unknown) => {
          if (value && typeof value === 'object') {
            const row = value as Record<string, unknown>;
            if (typeof row.access_token === 'string') access = row.access_token;
            Object.values(row).forEach(find);
          }
        };
        for (const file of (await readdir(home)).filter((n) => n.endsWith('.json')))
          find(JSON.parse(await readFile(join(home, file), 'utf8')));
        assert.ok(access, 'CLI did not save an OAuth token in its isolated credentials store');
        const grant = await db.agentGrant.findFirstOrThrow({ where: { userId, clientId } });
        assert.deepEqual(grant.scopes, ['read', 'draft']);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(resource), {
            requestInit: { headers: { Authorization: 'Bearer ' + access } },
          }),
        );
        assert.equal((await client.listTools()).tools.length, 39);
        async function call(name: string, args: Record<string, unknown> = {}) {
          const result = await client.callTool({ name, arguments: args });
          assert.ok(!result.isError, 'Tool failed: ' + name);
          return (result.structuredContent as { data: any }).data;
        }
        const info = await call('connection_info');
        assert.deepEqual(info.scopes, ['read', 'draft']);
        assert.equal(info.permission, 'draft');
        assert.equal(info.readHidden, false);
        assert.equal(info.writeHidden, false);
        const state = (await call('state_get')).state;
        const operation = await call('position_create', {
          kind: 'account',
          side: 'asset',
          name: 'Must remain draft',
          category: 'cash',
          currency: 'CNY',
          amount: '25.50',
          date: today(),
          notes: '',
          expectedState: state,
          idempotencyKey: randomUUID(),
        });
        assert.equal(operation.status, 'pending');
        assert.equal(
          await db.position.count({ where: { userId } }),
          0,
          'Draft unexpectedly posted financial data',
        );
        console.log(
          JSON.stringify({
            requestedScopes: requested,
            grantedScopes: info.scopes,
            readHidden: info.readHidden,
            writeHidden: info.writeHidden,
            ordinaryWrite: operation.status,
            tools: 39,
          }),
        );
      } finally {
        cli?.kill();
        await client.close().catch(() => {});
        if (userId) await db.user.deleteMany({ where: { id: userId } });
        if (clientId) {
          await db.agentAuthorization.deleteMany({ where: { clientId } });
          await db.agentClient.deleteMany({ where: { id: clientId } });
        }
        await db.$disconnect();
        assert.ok(
          resolve(home).startsWith(resolve(tmpdir()) + sep) &&
            basename(home).startsWith('worthpath-codex-scope-'),
        );
        await rm(home, { recursive: true, force: true });
      }
    },
  );
