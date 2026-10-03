import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { today } from '../src/validation';
import { readBackupZip } from '../src/zip';
import sharp from 'sharp';
const root = process.env.TEST_API_URL?.replace(/\/api$/, '') || 'http://127.0.0.1:3100';
const resource = process.env.MCP_PUBLIC_URL || 'http://localhost:3100/mcp';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;

test('official SDK Streamable HTTP: real MySQL full business paths, drafts, isolation, hidden permissions and removed capabilities', async () => {
  const db = new PrismaClient(),
    users: string[] = [],
    clients: Client[] = [];
  async function web(cookie: string, path: string, method = 'GET', body?: unknown) {
    const response = await fetch(root + '/api' + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie,
    };
  }
  async function fixture(
    mode = 'direct',
    selected = mode === 'direct'
      ? ['read', 'write']
      : mode === 'draft'
        ? ['read', 'draft']
        : ['read'],
  ) {
    const username = 'mcp_test_' + randomUUID().slice(0, 12),
      password = randomBytes(20).toString('hex');
    const registered = await web('', '/auth/register', 'POST', { username, password });
    assert.equal(registered.status, 201);
    const user = await db.user.findUniqueOrThrow({ where: { username } });
    users.push(user.id);
    await db.agentPolicy.create({ data: { userId: user.id, mode: 'readonly' } }); // Historical policy must not override connection permissions.
    const cookie = registered.cookie;
    const token = await web(cookie, '/agent/tokens', 'POST', {
      name: 'Official SDK integration',
      days: 1,
      scopes: selected,
      password,
    });
    assert.equal(token.status, 201);
    const client = new Client({ name: 'WorthPath integration', version: '1.31.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: 'Bearer ' + token.data.token } },
      }),
    );
    return {
      id: user.id,
      client,
      cookie,
      password,
      token: token.data.token,
      grantId: token.data.id,
    };
  }
  async function call(a: any, name: string, args: any = {}) {
    const v: any = await a.client.callTool({ name, arguments: args });
    assert.ok(!v.isError, JSON.stringify(v));
    return v.structuredContent.data;
  }
  async function fail(a: any, name: string, args: any = {}) {
    const v: any = await a.client.callTool({ name, arguments: args });
    assert.equal(v.isError, true, JSON.stringify(v));
    return v;
  }
  async function write(a: any, name: string, args: any = {}) {
    const state = (await call(a, 'state_get')).state;
    return call(a, name, { ...args, expectedState: state, idempotencyKey: randomUUID() });
  }
  async function confirm(a: any, operation: any, extra: any = {}) {
    const v = await web(a.cookie, '/agent/operations/' + operation.operationId, 'POST', {
      approve: true,
      ...extra,
    });
    assert.equal(v.status, 201, JSON.stringify(v.data));
    a.cookie = v.cookie;
    return call(a, 'operation_get', { operationId: operation.operationId });
  }
  const day = today(),
    position = {
      kind: 'account',
      side: 'asset',
      name: 'same name',
      category: 'cash',
      currency: 'CNY',
      amount: '1000.87654321',
      date: day,
      notes: '',
    };
  try {
    const unauth = await fetch(resource, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata/);
    const metadata = await (await fetch(root + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.equal(metadata.resource, resource);
    const a = await fixture(),
      b = await fixture(),
      d = await fixture('draft', ['read', 'draft']);
    await call(a, 'connection_info');
    const discovered = await a.client.listTools();
    assert.equal(discovered.tools.length, 39);
    assert.ok(!discovered.tools.some((t) => t.name === 'metal_price_set'));
    assert.equal(
      discovered.tools.find((t) => t.name === 'positions_list')!.annotations!.readOnlyHint,
      true,
    );
    const first = await write(a, 'position_create', position),
      cash = first.result.id;
    const second = (await write(a, 'position_create', { ...position, amount: '0' })).result.id;
    const liability = (
      await write(a, 'position_create', {
        ...position,
        name: 'credit',
        side: 'liability',
        category: 'credit_card',
        amount: '100',
      })
    ).result.id;
    const debt = (
      await write(a, 'position_create', {
        ...position,
        kind: 'debt',
        side: 'liability',
        name: 'loan',
        category: 'loan',
        amount: '100',
      })
    ).result.id;
    const metal = (
      await write(a, 'position_create', {
        ...position,
        kind: 'asset',
        category: 'gold',
        name: 'gold',
        amount: '200',
      })
    ).result.id;
    assert.equal((await call(a, 'positions_list', { limit: 1, q: 'same name' })).total, 2);
    assert.equal((await call(a, 'positions_list', { limit: 1, q: 'same name' })).nextOffset, 1);
    await fail(b, 'position_get', { id: cash });
    await fail(a, 'positions_list', { userId: b.id });
    await fail(a, 'position_create', {
      ...position,
      amount: 12,
      idempotencyKey: randomUUID(),
      expectedState: (await call(a, 'state_get')).state,
    });
    const key = randomUUID(),
      state = (await call(a, 'state_get')).state,
      args = { ...position, name: 'idempotent', expectedState: state, idempotencyKey: key };
    const once = await call(a, 'position_create', args),
      again = await call(a, 'position_create', args);
    assert.equal(once.result.id, again.result.id);
    await fail(a, 'position_create', { ...args, name: 'changed' });
    await fail(a, 'balance_record', {
      id: cash,
      data: { amount: '10', date: day },
      idempotencyKey: randomUUID(),
      expectedState: state,
    });
    const draft = await write(d, 'position_create', position);
    assert.equal(draft.status, 'pending');
    assert.equal((await call(d, 'positions_list')).total, 0);
    assert.equal((await web(b.cookie, '/agent/operations/' + draft.operationId)).status, 404);
    assert.equal(
      (
        await web(d.cookie, '/agent/operations/' + draft.operationId, 'POST', {
          approve: true,
          confirmed: true,
        })
      ).status,
      400,
    );
    const applied = await confirm(d, draft);
    assert.ok(applied.result.id);
    assert.equal((await call(d, 'positions_list')).total, 1);
    const expired = await write(d, 'position_create', { ...position, name: 'expired' });
    await db.agentOperation.update({
      where: { id: expired.operationId },
      data: { expiresAt: new Date(0) },
    });
    assert.equal(
      (await call(d, 'operation_get', { operationId: expired.operationId })).status,
      'expired',
    );
    assert.equal(
      (await web(d.cookie, '/agent/operations/' + expired.operationId, 'POST', { approve: true }))
        .status,
      409,
    );
    const cancelled = await write(d, 'position_create', { ...position, name: 'cancelled' });
    assert.equal(
      (
        await web(d.cookie, '/agent/operations/' + cancelled.operationId, 'POST', {
          approve: false,
        })
      ).status,
      201,
    );
    const stale = await write(d, 'position_create', { ...position, name: 'stale' });
    await web(d.cookie, '/settings', 'PATCH', { showNotes: false });
    assert.equal(
      (await web(d.cookie, '/agent/operations/' + stale.operationId, 'POST', { approve: true }))
        .status,
      409,
    );
    const mv = (
      await write(a, 'movement_create', {
        sourceId: cash,
        targetId: second,
        amount: '30.00000001',
        received: '30.00000001',
        fee: '0',
        date: day,
      })
    ).result;
    assert.equal((await call(a, 'position_get', { id: cash })).amount, '970.8765432');
    await write(a, 'movement_update', {
      id: mv.id,
      data: { sourceId: cash, targetId: second, amount: '40', received: '40', fee: '0', date: day },
    });
    assert.equal((await call(a, 'position_get', { id: second })).amount, '40');
    const movementPage = await call(a, 'movements_list', { limit: 1 });
    await call(a, 'movement_by_revision', { revisionId: movementPage.items[0].sourceRevisionId });
    await write(a, 'movement_delete', { id: mv.id });
    assert.equal((await call(a, 'position_get', { id: cash })).amount, '1000.87654321');
    await write(a, 'movement_create', {
      operation: 'repay',
      sourceId: cash,
      targetId: debt,
      amount: '10',
      received: '10',
      date: day,
    });
    assert.equal((await call(a, 'position_get', { id: debt })).amount, '90');
    await write(a, 'movement_create', {
      sourceId: cash,
      targetId: liability,
      amount: '150',
      received: '150',
      date: day,
    });
    assert.equal((await call(a, 'position_get', { id: liability })).amount, '-50');
    await write(a, 'debt_links_set', { id: debt, targetIds: [cash, metal] });
    const rev = (
      await write(a, 'balance_record', {
        id: second,
        data: { amount: '33.25', date: day, reason: 'balance' },
      })
    ).result;
    await write(a, 'history_update', {
      id: second,
      revisionId: rev.id,
      data: { amount: '35.25', date: day },
    });
    assert.equal((await call(a, 'position_get', { id: second })).amount, '35.25');
    await write(a, 'history_delete', { id: second, revisionId: rev.id });
    assert.equal((await call(a, 'position_get', { id: second })).amount, '0');
    const h = await call(a, 'history_list', { limit: 1 });
    assert.equal(h.items.length, 1);
    assert.ok(h.nextCursor);
    await call(a, 'history_list', { limit: 1, cursor: h.nextCursor });
    await write(a, 'settings_update', {
      accountGroupOrder: ['invest', ''],
      baseCurrency: 'CNY',
      overviewCards: ['net'],
      includeIndependentAssets: true,
    });
    await write(a, 'position_update', {
      id: cash,
      data: {
        name: 'cash',
        category: 'cash',
        groupName: 'invest',
        notes: 'memo',
        archived: false,
        hidden: false,
        included: true,
      },
    });
    await write(a, 'position_update', {
      id: metal,
      data: { name: 'gold', category: 'gold', notes: '', archived: true, hidden: false },
    });
    await fail(a, 'balance_record', {
      id: metal,
      data: { amount: '1', date: day },
      expectedState: (await call(a, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    await write(a, 'position_update', {
      id: metal,
      data: { name: 'gold', category: 'gold', notes: '', archived: false, hidden: false },
    });
    await db.metalPrice.create({
      data: {
        userId: a.id,
        metalType: 'gold',
        currency: 'CNY',
        price: '10.876543210987',
        date: new Date(day),
        source: 'goldapi',
        quotedAt: new Date(),
      },
    });
    await write(a, 'metal_configure', {
      id: metal,
      data: { metalType: 'gold', metalGrams: '2', autoValuation: true },
    });
    assert.equal((await call(a, 'position_get', { id: metal })).amount, '21.75308642');
    await write(a, 'metal_value', { id: metal });
    const gram = (
      await write(a, 'metal_holding_create', {
        name: 'grams',
        currency: 'CNY',
        metalType: 'gold',
        metalGrams: '2',
        autoValuation: true,
        metalCostPerGram: '9',
        date: day,
      })
    ).result.id;
    const gramDetail = await call(a, 'position_get', { id: gram });
    assert.equal(gramDetail.metalCost, '18.00000000');
    assert.equal(gramDetail.metalProfit, '3.75308642');
    await call(a, 'metals_prices');
    await call(a, 'settings_get');
    await call(a, 'overview_get', { limit: 1 });
    await call(a, 'trend_get', { from: day, to: day, grain: 'day' });
    await call(a, 'calendar_month', { month: day.slice(0, 7) });
    await call(a, 'calendar_day', { date: day, limit: 1 });
    await call(a, 'icons_list', { q: '', page: 1 });
    const planInput = {
      name: 'once',
      operation: 'expense',
      sourceId: cash,
      amount: '1.25',
      nextAt: day + 'T00:00',
      intervalDays: 0,
    };
    const plan = (await write(a, 'schedule_create', planInput)).result.id;
    await write(a, 'schedule_update', { id: plan, data: { ...planInput, amount: '2.25' } });
    await write(a, 'schedule_toggle', { id: plan, enabled: false });
    await call(a, 'schedules_list', { limit: 1 });
    await write(a, 'schedule_toggle', { id: plan, enabled: true });
    const before = (await call(a, 'position_get', { id: cash })).amount;
    assert.equal((await write(a, 'schedules_run')).result.executed, 1);
    assert.notEqual((await call(a, 'position_get', { id: cash })).amount, before);
    assert.equal((await write(a, 'schedules_run')).result.executed, 0);
    await write(a, 'schedule_delete', { id: plan });
    const hidden = (await write(a, 'position_create', { ...position, name: 'hidden' })).result.id;
    await db.position.update({ where: { id: hidden }, data: { hidden: true } });
    await fail(a, 'position_get', { id: hidden });
    await fail(a, 'debt_links_set', {
      id: debt,
      targetIds: [hidden],
      expectedState: (await call(a, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    await fail(d, 'settings_update', {
      requireHiddenPassword: false,
      expectedState: (await call(d, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    for (const removed of [
      'rates_refresh',
      'metals_refresh',
      'metal_price_set',
      'backup_export',
      'backup_import',
      'credentials_change_request',
      'hidden_unlock_request',
      'hidden_lock',
      'data_clear_request',
      'import_preview',
    ]) {
      assert.ok(!discovered.tools.some((t) => t.name === removed));
      await fail(a, removed);
    }
    await db.agentGrant.update({
      where: { id: a.grantId },
      data: { scopes: ['read', 'write', 'hidden_read'] },
    });
    assert.equal((await call(a, 'position_get', { id: hidden })).id, hidden);
    await fail(a, 'position_update', {
      id: hidden,
      data: { name: 'forbidden', category: 'cash', hidden: true },
      expectedState: (await call(a, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    await db.agentGrant.update({
      where: { id: a.grantId },
      data: { scopes: ['read', 'write', 'hidden_read', 'hidden_write'] },
    });
    await write(a, 'position_update', {
      id: hidden,
      data: { name: 'authorized hidden', category: 'cash', hidden: true },
    });
    assert.equal(
      (await db.position.findUniqueOrThrow({ where: { id: hidden } })).name,
      'authorized hidden',
    );
    await db.agentGrant.update({ where: { id: a.grantId }, data: { scopes: ['read'] } });
    await fail(a, 'position_create', {
      ...position,
      expectedState: (await call(a, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    await db.agentGrant.update({ where: { id: b.grantId }, data: { expiresAt: new Date(0) } });
    assert.equal(
      (
        await fetch(resource, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + b.token, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    await call(d, 'connection_revoke');
    assert.equal(
      (
        await fetch(resource, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + d.token, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    const originDenied = await fetch(resource, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.invalid',
        Authorization: 'Bearer ' + a.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(originDenied.status, 403);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});

test('real concurrent MCP idempotency, stale writes, icon workflow, nested rollback', async () => {
  const db = new PrismaClient();
  const username = 'mcp_extra_' + randomUUID().slice(0, 10),
    password = randomBytes(20).toString('hex');
  let userId = '',
    cookie = '';
  const clients: Client[] = [];
  const iconIds: string[] = [];
  async function web(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(root + '/api' + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    cookie = r.headers.get('set-cookie')?.split(';')[0] || cookie;
    return { status: r.status, data: await r.json() };
  }
  async function tool(c: Client, name: string, args: any = {}) {
    return c.callTool({ name, arguments: args }) as Promise<any>;
  }
  async function call(c: Client, name: string, args: any = {}) {
    const r = await tool(c, name, args);
    assert.ok(!r.isError, JSON.stringify(r));
    return r.structuredContent.data;
  }
  async function write(c: Client, name: string, args: any = {}) {
    return call(c, name, {
      ...args,
      expectedState: (await call(c, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
  }
  try {
    assert.equal((await web('/auth/register', 'POST', { username, password })).status, 201);
    userId = (await db.user.findUniqueOrThrow({ where: { username } })).id;
    const grant = (
      await web('/agent/tokens', 'POST', {
        name: 'extra',
        days: 1,
        scopes: ['read', 'write'],
        password,
      })
    ).data;
    const headers = { Authorization: 'Bearer ' + grant.token };
    for (let i = 0; i < 2; i++) {
      const c = new Client({ name: 'concurrent', version: '1.31.0' });
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers } }),
      );
    }
    const c = clients[0],
      position = {
        kind: 'account',
        side: 'asset',
        name: 'concurrent',
        category: 'cash',
        currency: 'CNY',
        amount: '100',
        date: today(),
      };
    const args = {
      ...position,
      idempotencyKey: randomUUID(),
      expectedState: (await call(c, 'state_get')).state,
    };
    const [one, two] = await Promise.all(
      clients.map((client) => call(client, 'position_create', args)),
    );
    assert.equal(one.operationId, two.operationId);
    assert.equal(await db.position.count({ where: { userId } }), 1);
    const state = (await call(c, 'state_get')).state;
    const results = await Promise.all(
      clients.map((client) =>
        tool(client, 'position_create', {
          ...position,
          name: randomUUID(),
          expectedState: state,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    assert.equal(results.filter((r) => !r.isError).length, 1);
    assert.equal(await db.position.count({ where: { userId } }), 2);
    const upload = await call(c, 'file_upload_request', { kind: 'icon' }),
      form = new FormData();
    form.append(
      'file',
      new Blob([
        await sharp({ create: { width: 4, height: 4, channels: 4, background: '#33aa88' } })
          .png()
          .toBuffer(),
      ]),
      'icon.png',
    );
    assert.equal((await fetch(upload.url, { method: 'POST', headers, body: form })).status, 200);
    const published = (
      await write(c, 'icon_publish', { fileId: upload.fileId, name: '测试私有图标', shared: false })
    ).result;
    iconIds.push(published.id);
    const image = await call(c, 'icon_image', { id: published.id });
    assert.equal((await fetch(image.url, { headers })).status, 200);
    const forbiddenShared = await tool(c, 'icon_publish', {
      fileId: upload.fileId,
      name: '测试共享图标',
      shared: true,
      expectedState: (await call(c, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    assert.equal(forbiddenShared.isError, true);
    assert.equal(await db.icon.count({ where: { ownerId: userId, shared: true } }), 0);
    // A failed paired transfer leaves neither side changed, including inside outer
    // idempotency transaction and nested service savepoints.
    const account = one.result.id,
      foreign = randomUUID(),
      balance = (await call(c, 'position_get', { id: account })).amount;
    const failure = await tool(c, 'movement_create', {
      sourceId: account,
      targetId: foreign,
      amount: '1',
      received: '1',
      date: today(),
      expectedState: (await call(c, 'state_get')).state,
      idempotencyKey: randomUUID(),
    });
    assert.equal(failure.isError, true);
    assert.equal((await call(c, 'position_get', { id: account })).amount, balance);
    assert.equal(await db.transfer.count({ where: { userId } }), 0);
    const other = (await call(c, 'positions_list')).items.find((v: any) => v.id !== account).id;
    const good = (
      await write(c, 'schedule_create', {
        name: 'first valid',
        operation: 'expense',
        sourceId: account,
        amount: '2',
        nextAt: today() + 'T00:00',
        intervalDays: 0,
      })
    ).result.id;
    const bad = (
      await write(c, 'schedule_create', {
        name: 'second archived',
        operation: 'expense',
        sourceId: other,
        amount: '3',
        nextAt: today() + 'T00:01',
        intervalDays: 0,
      })
    ).result.id;
    await write(c, 'position_update', {
      id: other,
      data: { name: 'archived', category: 'cash', notes: '', archived: true, hidden: false },
    });
    const revisions = await db.revision.count({ where: { position: { userId } } });
    const batch = await tool(c, 'schedules_run', {
      idempotencyKey: randomUUID(),
      expectedState: (await call(c, 'state_get')).state,
    });
    assert.equal(batch.isError, true);
    assert.equal((await call(c, 'position_get', { id: account })).amount, balance);
    assert.equal(await db.revision.count({ where: { position: { userId } } }), revisions);
    assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: good } })).completed, false);
    await write(c, 'schedule_delete', { id: good });
    await write(c, 'schedule_delete', { id: bad });
    const management = (await web('/agent')).data;
    assert.ok(management.calls.some((v: any) => v.status === 'error'));
    assert.equal(JSON.stringify(management).includes(grant.token), false);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await db.icon.deleteMany({ where: { id: { in: iconIds } } });
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  }
});

test('official SDK OAuth discovery, DCR, PKCE, consent, one-use codes, rotation and resource validation', async () => {
  const db = new PrismaClient();
  const username = 'mcp_oauth_' + randomUUID().slice(0, 10),
    password = randomBytes(20).toString('hex');
  let userId = '',
    clientId = '';
  let saved: any,
    tokens: any,
    verifier = '',
    authorization: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: 'http://127.0.0.1:47891/callback',
    clientMetadata: {
      client_name: 'WorthPath official OAuth test',
      redirect_uris: ['http://127.0.0.1:47891/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write',
    },
    clientInformation: () => saved,
    saveClientInformation: (v) => {
      saved = v;
      clientId = v.client_id;
    },
    tokens: () => tokens,
    saveTokens: (v) => {
      tokens = v;
    },
    redirectToAuthorization: (v) => {
      authorization = v;
    },
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    state: () => 'test-state',
  };
  async function post(path: string, body: any, cookie = '') {
    const r = await fetch(root + path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie,
    };
  }
  try {
    const registered = await post('/api/auth/register', { username, password });
    assert.equal(registered.status, 201);
    userId = (await db.user.findUniqueOrThrow({ where: { username } })).id;
    assert.equal(await auth(provider, { serverUrl: resource, scope: 'read write' }), 'REDIRECT');
    assert.ok(authorization);
    const redirected = await fetch(authorization!, { redirect: 'manual' });
    assert.equal(redirected.status, 302);
    const location = new URL(redirected.headers.get('location')!);
    const id = location.searchParams.get('agent_authorization');
    assert.ok(id);
    const deniedEscalation = await post(
      '/api/agent/authorizations/' + id,
      { approve: true, scopes: ['read', 'write', 'hidden_read'] },
      registered.cookie,
    );
    assert.equal(deniedEscalation.status, 400);
    const consent = await post(
      '/api/agent/authorizations/' + id,
      { approve: true, scopes: ['read', 'write'] },
      registered.cookie,
    );
    assert.equal(consent.status, 201);
    const callback = new URL(consent.data.redirect);
    assert.equal(callback.searchParams.get('state'), 'test-state');
    const code = callback.searchParams.get('code')!;
    assert.equal(
      await auth(provider, { serverUrl: resource, authorizationCode: code }),
      'AUTHORIZED',
    );
    assert.ok(tokens.access_token);
    const old = tokens;
    const client = new Client({ name: 'oauth-client', version: '1.31.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }),
    );
    assert.ok((await client.listTools()).tools.length === 39);
    await client.close();
    async function exchange(params: Record<string, string>) {
      const r = await fetch(root + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
      return { status: r.status, data: await r.json() };
    }
    assert.equal(
      (
        await exchange({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: String(provider.redirectUrl),
          resource,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await exchange({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: old.refresh_token,
          resource: 'https://evil.invalid/mcp',
        })
      ).status,
      400,
    );
    const refreshed = await exchange({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: old.refresh_token,
      resource,
    });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.data.refresh_token, old.refresh_token);
    assert.equal(
      (
        await exchange({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: old.refresh_token,
          resource,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(resource, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + old.access_token,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      401,
    );
    const grant = await db.agentGrant.findFirstOrThrow({ where: { userId } });
    assert.notEqual(grant.accessDigest, refreshed.data.access_token);
    const revoke = await fetch(root + '/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: refreshed.data.access_token }),
    });
    assert.equal(revoke.status, 200);
    assert.equal(
      (
        await fetch(resource, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + refreshed.data.access_token,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
      401,
    );
  } finally {
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    if (clientId) await db.agentClient.deleteMany({ where: { id: clientId } });
    await db.$disconnect();
  }
});
test('fixed PAT durations, permanent session renewal, expiry, isolation and revocation are real', async () => {
  const db = new PrismaClient(),
    users: string[] = [],
    clients: Client[] = [];
  const { createHash } = await import('node:crypto'),
    { hash } = await import('bcryptjs');
  const password = 'Temporary-pat-test-Only!';
  async function fixture() {
    const u = await db.user.create({
      data: {
        username: 'pat_' + randomUUID(),
        passwordHash: await hash(password, 4),
        idleMinutes: 0,
      },
    });
    users.push(u.id);
    const token = randomBytes(32).toString('hex');
    await db.session.create({
      data: {
        id: createHash('sha256').update(token).digest('hex'),
        userId: u.id,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    return { id: u.id, cookie: 'wp_session=' + token };
  }
  async function web(u: any, path: string, method = 'GET', body?: unknown) {
    const r = await fetch(root + '/api' + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: u.cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    const a = await fixture(),
      b = await fixture();
    let permanent: any;
    const issuedTokens = new Map<string, string>();
    for (const days of [1, 3, 7, 30, 365, null]) {
      const issued = await web(a, '/agent/tokens', 'POST', {
        name: 'expiry fixture',
        scopes: ['read'],
        days,
        password,
      });
      assert.equal(issued.status, 201, JSON.stringify(issued.data));
      issuedTokens.set(issued.data.id, issued.data.token);
      const row = await db.agentGrant.findUniqueOrThrow({ where: { id: issued.data.id } });
      assert.equal(row.accessDigest, createHash('sha256').update(issued.data.token).digest('hex'));
      if (days === null) {
        assert.equal(row.expiresAt, null);
        permanent = issued.data;
      } else {
        assert.ok(row.expiresAt);
        assert.ok(Math.abs(+row.expiresAt! - Date.now() - days * 86400000) < 5000);
      }
    }
    assert.equal(
      (
        await web(a, '/agent/tokens', 'POST', {
          name: 'invalid duration',
          scopes: ['read'],
          days: 2,
          password,
        })
      ).status,
      400,
    );
    for (const scopes of [
      ['read', 'sensitive'],
      ['read', 'draft', 'write'],
      ['read', 'hidden_write'],
    ]) {
      assert.equal(
        (
          await web(a, '/agent/tokens', 'POST', {
            name: 'invalid scopes',
            scopes,
            days: 1,
            password,
          })
        ).status,
        400,
      );
    }
    assert.equal((await web(a, '/agent/policy', 'PUT', { mode: 'direct', password })).status, 404);
    const management = await web(a, '/agent');
    assert.equal(management.data.capabilities.length, 39);
    assert.ok(!management.data.capabilities.some((t: any) => t.name === 'metal_price_set'));
    assert.equal((await web(b, '/agent')).data.grants.length, 0);
    assert.equal((await web(b, '/agent/connections/' + permanent.id, 'DELETE')).status, 200);
    assert.equal(
      (await db.agentGrant.findUniqueOrThrow({ where: { id: permanent.id } })).revokedAt,
      null,
    );
    const row = await db.agentGrant.findUniqueOrThrow({ where: { id: permanent.id } });
    await db.session.delete({ where: { id: row.sessionId } });
    const client = new Client({ name: 'Permanent PAT test', version: '1.31.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: { headers: { Authorization: 'Bearer ' + permanent.token } },
      }),
    );
    const result: any = await client.callTool({ name: 'connection_info', arguments: {} });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.equal(result.structuredContent.data.expiresAt, null);
    const business: any = await client.callTool({
      name: 'positions_list',
      arguments: { limit: 1 },
    });
    assert.ok(!business.isError, JSON.stringify(business));
    assert.ok(
      (await db.session.findUniqueOrThrow({ where: { id: row.sessionId } })).expiresAt > new Date(),
    );
    assert.equal((await web(a, '/agent/connections/' + permanent.id, 'DELETE')).status, 200);
    await assert.rejects(() => client.listTools());
    const finite = management.data.grants.find((g: any) => g.expiresAt);
    await db.agentGrant.update({ where: { id: finite.id }, data: { expiresAt: new Date(0) } });
    const expiredClient = new Client({ name: 'Expired PAT test', version: '1.31.0' });
    clients.push(expiredClient);
    await assert.rejects(() =>
      expiredClient.connect(
        new StreamableHTTPClientTransport(new URL(resource), {
          requestInit: { headers: { Authorization: 'Bearer ' + issuedTokens.get(finite.id) } },
        }),
      ),
    );
    const expired = await web(a, '/agent');
    assert.equal(
      expired.data.grants.find((g: any) => g.id === finite.id).expiresAt,
      '1970-01-01T00:00:00.000Z',
    );
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    await db.user.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  }
});
