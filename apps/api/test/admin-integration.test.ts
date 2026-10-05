import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuthService } from '../src/auth';
import { Database } from '../src/database';
import { AgentOAuth } from '../src/mcp/oauth';

test(
  'admin bootstrap, closed registration, mandatory password change, roles and ban revoke sessions and MCP',
  { skip: process.env.TEST_ISOLATED !== 'true' },
  async () => {
    const db = new PrismaClient();
    const base = process.env.TEST_API_URL!;
    const origin = process.env.WEB_ORIGIN!;
    async function call(path: string, method = 'GET', body?: unknown, cookie = '') {
      const r = await fetch(base + path, {
        method,
        headers: {
          Origin: origin,
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
    try {
      assert.equal(
        (await call('/auth/register', 'POST', { username: 'blocked', password: 'long-password' }))
          .status,
        403,
      );
      assert.equal(await db.user.count({ where: { username: 'blocked' } }), 0);
      const initial = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
      assert.equal(initial.role, 'admin');
      assert.equal(initial.mustChangePassword, true);
      const login = await call('/auth/login', 'POST', { username: 'admin', password: 'admin' });
      assert.equal(login.status, 201);
      assert.equal(login.data.mustChangePassword, true);
      assert.equal((await call('/overview', 'GET', undefined, login.cookie)).status, 403);
      assert.equal((await call('/admin/users', 'GET', undefined, login.cookie)).status, 403);
      assert.equal(
        (
          await call(
            '/agent/tokens',
            'POST',
            { name: 'blocked', scopes: ['read'], days: 1, password: 'admin' },
            login.cookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            '/auth/credentials',
            'PATCH',
            { currentPassword: 'admin', username: 'renamed' },
            login.cookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            '/auth/credentials',
            'PATCH',
            { currentPassword: 'admin', newPassword: 'short' },
            login.cookie,
          )
        ).status,
        400,
      );
      const password = 'Admin-new-' + randomUUID();
      const changed = await call(
        '/auth/credentials',
        'PATCH',
        { currentPassword: 'admin', newPassword: password },
        login.cookie,
      );
      assert.equal(changed.status, 200);
      const cookie = changed.cookie;
      assert.equal(
        (await call('/auth/me', 'GET', undefined, cookie)).data.mustChangePassword,
        false,
      );
      assert.equal((await call('/auth/me', 'GET', undefined, login.cookie)).status, 401);
      const savedHash = (await db.user.findUniqueOrThrow({ where: { id: initial.id } }))
        .passwordHash;
      await new AuthService(db as Database).onModuleInit();
      assert.equal(
        (await db.user.findUniqueOrThrow({ where: { id: initial.id } })).passwordHash,
        savedHash,
      );
      assert.equal(
        (await call('/auth/login', 'POST', { username: 'admin', password: 'admin' })).status,
        401,
      );
      assert.equal(
        (await call('/admin/users/' + initial.id, 'PATCH', { banned: true }, cookie)).status,
        403,
      );
      const username = 'admin_test_' + randomUUID().slice(0, 10),
        first = 'Initial-' + randomUUID();
      const created = await call(
        '/admin/users',
        'POST',
        { username, password: first, role: 'user' },
        cookie,
      );
      assert.equal(created.status, 201);
      assert.equal(created.data.mustChangePassword, true);
      assert.equal('passwordHash' in created.data, false);
      const id = created.data.id;
      assert.equal(
        (await call('/admin/users', 'POST', { username, password: first }, cookie)).status,
        409,
      );
      assert.equal(
        (
          await call(
            '/admin/users',
            'POST',
            { username: username + '_bad', password: first, role: 'superuser' },
            cookie,
          )
        ).status,
        400,
      );
      const fresh = await call('/auth/login', 'POST', { username, password: first });
      assert.equal((await call('/positions', 'GET', undefined, fresh.cookie)).status, 403);
      assert.equal(
        (
          await call(
            '/auth/credentials',
            'PATCH',
            { currentPassword: first, newPassword: first },
            fresh.cookie,
          )
        ).status,
        400,
      );
      const regularPassword = 'Changed-' + randomUUID();
      const updated = await call(
        '/auth/credentials',
        'PATCH',
        { currentPassword: first, newPassword: regularPassword },
        fresh.cookie,
      );
      assert.equal(updated.status, 200);
      const regular = updated.cookie;
      assert.equal((await call('/admin/users', 'GET', undefined, regular)).status, 403);
      assert.equal(
        (
          await call(
            '/admin/users',
            'POST',
            { username: 'escalate', password: first, role: 'admin' },
            regular,
          )
        ).status,
        403,
      );
      const token = await call(
        '/agent/tokens',
        'POST',
        { name: 'ban-test', scopes: ['read', 'write'], days: 1, password: regularPassword },
        regular,
      );
      assert.equal(token.status, 201);
      const oauth = new AgentOAuth(db as Database);
      await oauth.verifyAccessToken(token.data.token);
      assert.equal(
        (await call('/admin/users/' + id, 'PATCH', { role: 'readonly' }, cookie)).status,
        200,
      );
      assert.equal((await call('/auth/me', 'GET', undefined, regular)).status, 401);
      await assert.rejects(oauth.verifyAccessToken(token.data.token));
      const readonly = await call('/auth/login', 'POST', { username, password: regularPassword });
      assert.equal((await call('/positions', 'GET', undefined, readonly.cookie)).status, 200);
      assert.equal((await call('/positions', 'POST', {}, readonly.cookie)).status, 403);
      assert.equal((await call('/schedules/run', 'POST', {}, readonly.cookie)).status, 403);
      assert.equal(
        (
          await call(
            '/agent/tokens',
            'POST',
            { name: 'escalate', scopes: ['read', 'draft'], days: 1, password: regularPassword },
            readonly.cookie,
          )
        ).status,
        403,
      );
      const readToken = await call(
        '/agent/tokens',
        'POST',
        { name: 'readonly', scopes: ['read'], days: 1, password: regularPassword },
        readonly.cookie,
      );
      assert.equal(readToken.status, 201);
      const readInfo = await oauth.verifyAccessToken(readToken.data.token);
      assert.deepEqual(readInfo.scopes, ['read']);
      const list = await call('/admin/users?limit=1&offset=1', 'GET', undefined, cookie);
      assert.equal(list.data.items.length, 1);
      assert.ok(list.data.total >= 2);
      assert.equal(
        (await call('/admin/users/' + id, 'PATCH', { banned: true }, cookie)).status,
        200,
      );
      assert.equal(
        (await call('/auth/login', 'POST', { username, password: regularPassword })).status,
        403,
      );
      assert.equal((await call('/auth/me', 'GET', undefined, readonly.cookie)).status, 401);
      await assert.rejects(oauth.verifyAccessToken(readToken.data.token));
      assert.equal(await db.session.count({ where: { userId: id } }), 0);
      assert.equal(
        (await call('/admin/users/' + id, 'PATCH', { banned: false, role: 'user' }, cookie)).status,
        200,
      );
      const unbanned = await call('/auth/login', 'POST', { username, password: regularPassword });
      assert.equal(unbanned.status, 201);
      assert.equal((await call('/overview', 'GET', undefined, unbanned.cookie)).status, 200);
    } finally {
      await db.$disconnect();
    }
  },
);
