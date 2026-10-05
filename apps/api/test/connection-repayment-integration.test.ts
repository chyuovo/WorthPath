import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { Database } from '../src/database';
import { AgentOAuth, urls } from '../src/mcp/oauth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { today } from '../src/validation';

test(
  'connection permission edits, OAuth refresh, account repayment drafts and protecting non-default user accounts',
  {
    skip: process.env.TEST_ISOLATED !== 'true',
  },
  async () => {
    const db = new Database(),
      oauth = new AgentOAuth(db);
    const ids: string[] = [],
      clients: Client[] = [];
    let clientId = '';
    const password = randomBytes(20).toString('hex');
    const base = process.env.TEST_API_URL!;
    async function web(cookie: string, path: string, method = 'GET', body?: unknown) {
      const r = await fetch(base + path, {
        method,
        headers: {
          Origin: process.env.WEB_ORIGIN!,
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: r.status,
        data: await r.json(),
        cookie: r.headers.get('set-cookie')?.split(';')[0] || cookie,
      };
    }
    async function user(role: 'admin' | 'user' | 'readonly') {
      const u = await db.user.create({
        data: {
          username: 'update_access_' + randomUUID(),
          role,
          passwordHash: await hash(password, 10),
        },
      });
      ids.push(u.id);
      const login = await web('', '/auth/login', 'POST', { username: u.username, password });
      assert.equal(login.status, 201);
      return { ...u, cookie: login.cookie };
    }
    async function connect(token: string) {
      const client = new Client({ name: 'Update regression', version: '1' });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(urls().resource, {
          requestInit: { headers: { Authorization: 'Bearer ' + token } },
        }),
      );
      assert.ok((await client.listTools()).tools.some((t) => t.name === 'movement_create'));
      return client;
    }
    async function tool(c: Client, name: string, args: any = {}) {
      const r: any = await c.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent.data;
    }
    async function draft(c: Client, name: string, args: any) {
      return tool(c, name, {
        ...args,
        expectedState: (await tool(c, 'state_get')).state,
        idempotencyKey: randomUUID(),
      });
    }
    const position = {
      kind: 'account',
      side: 'asset',
      name: 'payer',
      category: 'bank',
      currency: 'CNY',
      amount: '100',
      date: today(),
      notes: '',
    };
    try {
      const admin = await user('admin'),
        owner = await user('user'),
        readonly = await user('readonly');
      const pat = await web(owner.cookie, '/agent/tokens', 'POST', {
        name: 'draft grant',
        scopes: ['read', 'draft'],
        days: 1,
        password,
      });
      assert.equal(pat.status, 201);
      const sdk = await connect(pat.data.token);
      const pending = await draft(sdk, 'position_create', position);
      assert.equal(pending.status, 'pending');
      assert.equal(
        (
          await web(owner.cookie, '/agent/connections/' + pat.data.id, 'PATCH', {
            scopes: ['read', 'draft'],
            password,
          })
        ).status,
        200,
      );
      assert.equal(
        (await tool(sdk, 'operation_get', { operationId: pending.operationId })).status,
        'pending',
      );

      const path = '/agent/connections/' + pat.data.id;
      assert.equal(
        (await web(admin.cookie, path, 'PATCH', { scopes: ['read', 'write'], password })).status,
        404,
      );
      assert.equal(
        (await web(owner.cookie, path, 'PATCH', { scopes: ['read', 'write'], password: 'wrong' }))
          .status,
        403,
      );
      assert.equal(
        (await web(owner.cookie, path, 'PATCH', { scopes: ['read', 'draft', 'write'], password }))
          .status,
        400,
      );
      const before = await db.agentGrant.findUniqueOrThrow({ where: { id: pat.data.id } });
      assert.equal(
        (await web(owner.cookie, path, 'PATCH', { scopes: ['read', 'write'], password })).status,
        200,
      );
      assert.equal((await tool(sdk, 'connection_info')).permission, 'write');
      assert.equal(
        (await tool(sdk, 'operation_get', { operationId: pending.operationId })).status,
        'cancelled',
      );
      assert.equal(
        (
          await db.agentGrant.findUniqueOrThrow({ where: { id: before.id } })
        ).expiresAt?.toISOString(),
        before.expiresAt?.toISOString(),
      );
      assert.equal(await db.position.count({ where: { userId: owner.id } }), 0);
      assert.equal(
        (await web(owner.cookie, path, 'PATCH', { scopes: ['read', 'draft'], password })).status,
        200,
      );

      const source = await web(owner.cookie, '/positions', 'POST', position);
      const target = await web(owner.cookie, '/positions', 'POST', {
        ...position,
        side: 'liability',
        name: 'credit',
        category: 'credit_card',
        amount: '80',
      });
      assert.equal(source.status, 201);
      assert.equal(target.status, 201);
      const repayment = {
        operation: 'repay',
        sourceId: source.data.id,
        targetId: target.data.id,
        amount: '50',
        received: '50',
        fee: '-2',
        date: today(),
        notes: '',
      };
      const pay = await draft(sdk, 'movement_create', repayment);
      assert.equal(pay.status, 'pending');
      assert.equal((await tool(sdk, 'position_get', { id: source.data.id })).amount, '100');
      const approved = await web(owner.cookie, '/agent/operations/confirm-batch', 'POST', {
        approve: true,
        operationIds: [pay.operationId],
      });
      assert.equal(approved.status, 201, JSON.stringify(approved.data));
      const applied = await tool(sdk, 'operation_get', { operationId: pay.operationId });
      assert.equal(applied.status, 'completed');
      assert.equal((await tool(sdk, 'position_get', { id: source.data.id })).amount, '52');
      assert.equal((await tool(sdk, 'position_get', { id: target.data.id })).amount, '30');
      const record = await db.transfer.findUniqueOrThrow({ where: { id: applied.result.id } });
      assert.equal(record.operation, 'repay');
      assert.equal(await db.positionLink.count({ where: { sourceId: target.data.id } }), 0);
      assert.equal(
        (
          await web(owner.cookie, '/transfers/' + record.id, 'PUT', {
            ...repayment,
            amount: '90',
            received: '90',
            fee: '0',
          })
        ).status,
        200,
      );
      assert.equal((await tool(sdk, 'position_get', { id: target.data.id })).amount, '-10');
      assert.equal((await web(owner.cookie, '/transfers/' + record.id, 'DELETE')).status, 200);
      assert.equal((await tool(sdk, 'position_get', { id: source.data.id })).amount, '100');
      assert.equal((await tool(sdk, 'position_get', { id: target.data.id })).amount, '80');
      assert.equal(
        (
          await web(owner.cookie, '/transfers', 'POST', {
            ...repayment,
            sourceId: target.data.id,
            targetId: source.data.id,
          })
        ).status,
        400,
      );
      assert.equal((await web(admin.cookie, '/transfers', 'POST', repayment)).status, 400);

      const client = await oauth.clientsStore.registerClient({
        client_name: 'Permission regression',
        redirect_uris: ['http://127.0.0.1:47891/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      });
      clientId = client.client_id;
      const issued = await db.atomic(() =>
        oauth.issue(owner.id, 'OAuth regression', ['read'], 1 / 24, clientId, 7),
      );
      const oauthPath = '/agent/connections/' + issued.grant.id;
      const rights = ['read', 'write', 'hidden_read', 'hidden_write'];
      assert.equal(
        (await web(owner.cookie, oauthPath, 'PATCH', { scopes: rights, password })).status,
        200,
      );
      assert.deepEqual((await oauth.verifyAccessToken(issued.tokens.access_token)).scopes, rights);
      const refreshed = await oauth.exchangeRefreshToken(
        client,
        issued.tokens.refresh_token!,
        undefined,
        urls().resource,
      );
      assert.deepEqual((await oauth.verifyAccessToken(refreshed.access_token)).scopes, rights);
      assert.equal(
        (
          await db.agentGrant.findUniqueOrThrow({ where: { id: issued.grant.id } })
        ).refreshExpiresAt?.toISOString(),
        issued.grant.refreshExpiresAt?.toISOString(),
      );
      await db.agentGrant.update({
        where: { id: issued.grant.id },
        data: { expiresAt: new Date(0) },
      });
      assert.equal(
        (await web(owner.cookie, oauthPath, 'PATCH', { scopes: ['read'], password })).status,
        200,
      );
      const renewed = await oauth.exchangeRefreshToken(
        client,
        refreshed.refresh_token!,
        undefined,
        urls().resource,
      );
      assert.deepEqual((await oauth.verifyAccessToken(renewed.access_token)).scopes, ['read']);

      await assert.rejects(
        oauth.exchangeRefreshToken(
          client,
          renewed.refresh_token!,
          ['read', 'write'],
          urls().resource,
        ),
      );
      const concurrent = await Promise.all([
        web(owner.cookie, oauthPath, 'PATCH', { scopes: rights, password }),
        oauth.exchangeRefreshToken(client, renewed.refresh_token!, undefined, urls().resource),
      ]);
      assert.equal(concurrent[0].status, 200);
      assert.deepEqual((await oauth.verifyAccessToken(concurrent[1].access_token)).scopes, rights);
      await db.agentGrant.update({
        where: { id: issued.grant.id },
        data: { refreshExpiresAt: new Date(0) },
      });
      assert.equal(
        (await web(owner.cookie, oauthPath, 'PATCH', { scopes: ['read'], password })).status,
        404,
      );
      const openapi = await web(owner.cookie, '/openapi.json');
      assert.ok(
        openapi.data.paths['/api/agent/connections/{id}'].patch.requestBody.content[
          'application/json'
        ].schema.properties.scopes,
      );
      const ro = await web(readonly.cookie, '/agent/tokens', 'POST', {
        name: 'readonly',
        scopes: ['read'],
        days: 1,
        password,
      });
      assert.equal(ro.status, 201);
      assert.equal(
        (
          await web(readonly.cookie, '/agent/connections/' + ro.data.id, 'PATCH', {
            scopes: ['read', 'write'],
            password,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await web(readonly.cookie, '/agent/connections/' + ro.data.id, 'PATCH', {
            scopes: ['read', 'hidden_read'],
            password,
          })
        ).status,
        200,
      );
      await web(owner.cookie, path, 'DELETE');
      assert.equal(
        (await web(owner.cookie, path, 'PATCH', { scopes: ['read'], password })).status,
        404,
      );
      await assert.rejects(oauth.verifyAccessToken(pat.data.token));

      for (const targetUser of [owner, readonly, await user('admin')]) {
        const removePath = '/admin/users/' + targetUser.id;
        const body = { confirmationUsername: targetUser.username, currentPassword: password };
        assert.equal((await web(readonly.cookie, removePath, 'DELETE', body)).status, 403);
        assert.equal(
          (
            await web(admin.cookie, removePath, 'DELETE', {
              ...body,
              confirmationUsername: 'wrong',
            })
          ).status,
          403,
        );
        assert.equal(
          (await web(admin.cookie, removePath, 'DELETE', { ...body, currentPassword: 'wrong' }))
            .status,
          403,
        );
        assert.equal((await web(admin.cookie, removePath, 'DELETE', body)).status, 403);
        assert.ok(await db.user.findUnique({ where: { id: targetUser.id } }));
        if (targetUser.id === owner.id)
          assert.equal(await db.position.count({ where: { userId: targetUser.id } }), 2);
        if (targetUser.id === owner.id)
          assert.equal(await db.agentGrant.count({ where: { userId: targetUser.id } }), 2);
        assert.equal((await web(targetUser.cookie, '/auth/me')).status, 200);
      }
      assert.equal(
        (
          await web(admin.cookie, '/admin/users/' + admin.id, 'DELETE', {
            confirmationUsername: admin.username,
            currentPassword: password,
          })
        ).status,
        403,
      );
    } finally {
      for (const c of clients) await c.close().catch(() => {});
      await db.user.deleteMany({ where: { id: { in: ids } } });
      if (clientId) await db.agentClient.deleteMany({ where: { id: clientId } });
      await db.$disconnect();
    }
  },
);
