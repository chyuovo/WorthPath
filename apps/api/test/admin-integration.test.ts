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
      const originalDelete = { confirmationUsername: 'admin', currentPassword: password };
      assert.equal(
        (await call('/admin/users/' + initial.id, 'DELETE', originalDelete, cookie)).status,
        403,
      );
      assert.equal(
        (await call('/admin/users/' + initial.id, 'DELETE', originalDelete, unbanned.cookie))
          .status,
        403,
      );
      const replacementName = 'replacement_' + randomUUID().slice(0, 10);
      const replacementInitial = 'Initial-' + randomUUID();
      const replacement = await call(
        '/admin/users',
        'POST',
        { username: replacementName, password: replacementInitial, role: 'admin' },
        cookie,
      );
      assert.equal(replacement.status, 201);
      const firstLogin = await call('/auth/login', 'POST', {
        username: replacementName,
        password: replacementInitial,
      });
      assert.equal(
        (
          await call(
            '/admin/users/' + initial.id,
            'DELETE',
            { confirmationUsername: 'admin', currentPassword: replacementInitial },
            firstLogin.cookie,
          )
        ).status,
        403,
      );
      const replacementPassword = 'Changed-' + randomUUID();
      const replacementChanged = await call(
        '/auth/credentials',
        'PATCH',
        { currentPassword: replacementInitial, newPassword: replacementPassword },
        firstLogin.cookie,
      );
      assert.equal(replacementChanged.status, 200);
      const replacementCookie = replacementChanged.cookie;
      assert.equal(
        (
          await call(
            '/admin/users/' + initial.id,
            'DELETE',
            { confirmationUsername: 'admin', currentPassword: 'wrong' },
            replacementCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            '/admin/users/' + initial.id,
            'DELETE',
            { confirmationUsername: 'wrong-name', currentPassword: replacementPassword },
            replacementCookie,
          )
        ).status,
        400,
      );
      assert.ok(await db.user.findUnique({ where: { id: initial.id } }));
      const originalToken = await call(
        '/agent/tokens',
        'POST',
        { name: 'original-admin', scopes: ['read'], days: 1, password },
        cookie,
      );
      assert.equal(originalToken.status, 201);
      const privateIcon = await db.icon.create({
        data: {
          name: 'private-delete',
          ownerId: initial.id,
          shared: false,
          hash: 'a'.repeat(64),
          data: Buffer.from('test'),
        },
      });
      const sharedIcon = await db.icon.create({
        data: {
          name: 'shared-keep',
          ownerId: initial.id,
          shared: true,
          hash: 'b'.repeat(64),
          data: Buffer.from('test'),
        },
      });
      const position = await db.position.create({
        data: {
          userId: initial.id,
          name: 'delete-fixture',
          kind: 'account',
          side: 'asset',
          category: 'bank',
          currency: 'CNY',
          notes: '',
        },
      });
      await db.revision.create({
        data: {
          positionId: position.id,
          amount: '10',
          effectiveDate: new Date(),
          notes: '',
          reason: 'initial',
        },
      });
      assert.equal(
        (
          await call(
            '/admin/users/' + initial.id,
            'DELETE',
            { confirmationUsername: 'admin', currentPassword: replacementPassword },
            replacementCookie,
          )
        ).status,
        200,
      );
      assert.equal(await db.user.findUnique({ where: { id: initial.id } }), null);
      assert.equal(await db.position.findUnique({ where: { id: position.id } }), null);
      assert.equal(await db.revision.count({ where: { positionId: position.id } }), 0);
      assert.equal(await db.icon.findUnique({ where: { id: privateIcon.id } }), null);
      assert.equal(
        (await db.icon.findUniqueOrThrow({ where: { id: sharedIcon.id } })).ownerId,
        null,
      );
      assert.equal((await call('/auth/me', 'GET', undefined, cookie)).status, 401);
      assert.equal(
        (await call('/auth/login', 'POST', { username: 'admin', password })).status,
        401,
      );
      await assert.rejects(oauth.verifyAccessToken(originalToken.data.token));
      assert.equal(
        (
          await call(
            '/admin/users/' + replacement.data.id,
            'DELETE',
            { confirmationUsername: replacementName, currentPassword: replacementPassword },
            replacementCookie,
          )
        ).status,
        403,
      );
      await new AuthService(db as Database).onModuleInit();
      assert.equal(await db.user.count({ where: { username: 'admin' } }), 0);
      assert.equal((await call('/admin/users', 'GET', undefined, replacementCookie)).status, 200);
    } finally {
      await db.$disconnect();
    }
  },
);
