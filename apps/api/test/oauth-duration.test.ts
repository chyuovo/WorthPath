import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
const root = process.env.TEST_API_URL?.replace(/\/api$/, '') || 'http://127.0.0.1:3100';
const resource = process.env.MCP_PUBLIC_URL || 'http://localhost:3100/mcp';
const origin = process.env.WEB_ORIGIN === '*' ? 'http://localhost:5173' : process.env.WEB_ORIGIN!;
test('OAuth consent persists selected lifetime; refresh rotates and cannot extend authorization or access past its end', async () => {
  const db = new PrismaClient();
  let userId = '',
    clientId = '';
  try {
    const u = await db.user.create({
      data: { username: 'oauth_days_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    userId = u.id;
    const session = randomBytes(32).toString('hex'),
      sid = createHash('sha256').update(session).digest('hex');
    await db.session.create({
      data: { id: sid, userId, expiresAt: new Date(Date.now() + 3600000) },
    });
    const cookie = 'wp_session=' + session;
    clientId = randomUUID();
    const callback = 'http://127.0.0.1:47891/callback';
    await db.agentClient.create({
      data: {
        id: clientId,
        metadata: {
          client_id: clientId,
          client_name: '期限测试',
          redirect_uris: [callback],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
      },
    });
    async function authorization() {
      const verifier = randomBytes(32).toString('base64url'),
        id = randomUUID();
      await db.agentAuthorization.create({
        data: {
          id,
          clientId,
          expiresAt: new Date(Date.now() + 600000),
          parameters: {
            redirectUri: callback,
            resource,
            scopes: ['read', 'draft'],
            codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          },
        },
      });
      return { id, verifier };
    }
    async function consent(id: string, days?: number) {
      const r = await fetch(root + '/api/agent/authorizations/' + id, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approve: true,
          scopes: ['read', 'draft'],
          ...(days === undefined ? {} : { days }),
        }),
      });
      return { status: r.status, data: await r.json() };
    }
    async function token(data: Record<string, string>) {
      const r = await fetch(root + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, resource, ...data }),
      });
      return { status: r.status, data: await r.json() };
    }
    for (const days of [1, 3, 7, 30, 365, undefined]) {
      const a = await authorization(),
        approved = await consent(a.id, days);
      assert.equal(approved.status, 201);
      const code = new URL(approved.data.redirect).searchParams.get('code')!;
      const issued = await token({
        grant_type: 'authorization_code',
        code,
        code_verifier: a.verifier,
        redirect_uri: callback,
      });
      assert.equal(issued.status, 200);
      assert.equal(issued.data.expires_in, 3600);
      let grant = await db.agentGrant.findUniqueOrThrow({
        where: {
          accessDigest: createHash('sha256').update(issued.data.access_token).digest('hex'),
        },
      });
      const ending = +grant.refreshExpiresAt!;
      assert.ok(Math.abs(ending - Date.now() - (days ?? 30) * 86400000) < 5000);
      const sessionRow = await db.session.findUniqueOrThrow({ where: { id: grant.sessionId } });
      assert.equal(+sessionRow.expiresAt, ending);
      const refreshed = await token({
        grant_type: 'refresh_token',
        refresh_token: issued.data.refresh_token,
      });
      assert.equal(refreshed.status, 200);
      grant = await db.agentGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(+grant.refreshExpiresAt!, ending);
      const nearEnd = new Date(Date.now() + 50000);
      await db.agentGrant.update({ where: { id: grant.id }, data: { refreshExpiresAt: nearEnd } });
      const finalRefresh = await token({
        grant_type: 'refresh_token',
        refresh_token: refreshed.data.refresh_token,
      });
      assert.equal(finalRefresh.status, 200);
      assert.ok(finalRefresh.data.expires_in <= 50);
      grant = await db.agentGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(+grant.expiresAt!, +nearEnd);
      await db.agentGrant.update({
        where: { id: grant.id },
        data: { refreshExpiresAt: new Date(0) },
      });
      assert.equal(
        (
          await token({
            grant_type: 'refresh_token',
            refresh_token: finalRefresh.data.refresh_token,
          })
        ).status,
        400,
      );
      const request = await fetch(resource, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + finalRefresh.data.access_token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(request.status, 401);
    }
    for (const days of [0, 2, 366]) {
      const a = await authorization();
      assert.equal((await consent(a.id, days)).status, 400);
      assert.equal(
        (await db.agentAuthorization.findUniqueOrThrow({ where: { id: a.id } })).status,
        'pending',
      );
    }
  } finally {
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    if (clientId) {
      await db.agentAuthorization.deleteMany({ where: { clientId } });
      await db.agentClient.deleteMany({ where: { id: clientId } });
    }
    await db.$disconnect();
  }
});
test('permanent OAuth rotates credentials, renews deleted business session and remains revocable', async () => {
  const db = new PrismaClient();
  let userId = '',
    clientId = '';
  try {
    const u = await db.user.create({
      data: { username: 'oauth_permanent_' + randomUUID(), passwordHash: 'unused', idleMinutes: 0 },
    });
    userId = u.id;
    const cookieToken = randomBytes(32).toString('hex'),
      sid = createHash('sha256').update(cookieToken).digest('hex');
    await db.session.create({
      data: { id: sid, userId, expiresAt: new Date(Date.now() + 3600000) },
    });
    clientId = randomUUID();
    const redirectUri = 'http://127.0.0.1:47891/callback';
    await db.agentClient.create({
      data: {
        id: clientId,
        metadata: {
          client_id: clientId,
          client_name: '永久授权测试',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
      },
    });
    const id = randomUUID(),
      verifier = randomBytes(32).toString('base64url');
    await db.agentAuthorization.create({
      data: {
        id,
        clientId,
        parameters: {
          redirectUri,
          resource,
          scopes: ['read'],
          codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        },
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    const res = await fetch(root + '/api/agent/authorizations/' + id, {
      method: 'POST',
      headers: {
        Cookie: 'wp_session=' + cookieToken,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approve: true, scopes: ['read'], days: null }),
    });
    assert.equal(res.status, 201);
    const consent = await res.json();
    async function token(data: Record<string, string>) {
      const r = await fetch(root + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, resource, ...data }),
      });
      return { status: r.status, data: await r.json() };
    }
    const issued = await token({
      grant_type: 'authorization_code',
      code: new URL(consent.redirect).searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    });
    assert.equal(issued.status, 200);
    assert.equal(issued.data.expires_in, 3600);
    const grant = await db.agentGrant.findUniqueOrThrow({
      where: { accessDigest: createHash('sha256').update(issued.data.access_token).digest('hex') },
    });
    assert.equal(grant.refreshExpiresAt, null);
    assert.ok(grant.expiresAt);
    assert.equal(
      ((await db.agentAuthorization.findUniqueOrThrow({ where: { id } })).parameters as any)
        .authorizationDays,
      null,
    );
    await db.session.delete({ where: { id: grant.sessionId } });
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: issued.data.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    const renewed = await db.session.findUniqueOrThrow({ where: { id: grant.sessionId } });
    assert.ok(+renewed.expiresAt > Date.now() + 29 * 86400000);
    assert.equal(
      (await db.agentGrant.findUniqueOrThrow({ where: { id: grant.id } })).refreshExpiresAt,
      null,
    );
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: issued.data.refresh_token }))
        .status,
      400,
    );
    const revoke = await fetch(root + '/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: refreshed.data.access_token }),
    });
    assert.equal(revoke.status, 200);
    assert.equal(
      (await token({ grant_type: 'refresh_token', refresh_token: refreshed.data.refresh_token }))
        .status,
      400,
    );
    const denied = await fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + refreshed.data.access_token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(denied.status, 401);
  } finally {
    if (userId) await db.user.deleteMany({ where: { id: userId } });
    if (clientId) {
      await db.agentAuthorization.deleteMany({ where: { clientId } });
      await db.agentClient.deleteMany({ where: { id: clientId } });
    }
    await db.$disconnect();
  }
});
