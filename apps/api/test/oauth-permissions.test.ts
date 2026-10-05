import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

test(
  'OAuth read-only requests offer all three ordinary levels; explicit owner consent determines token scopes',
  { skip: process.env.TEST_ISOLATED !== 'true' },
  async () => {
    const db = new PrismaClient(),
      ids: string[] = [];
    const base = process.env.TEST_API_URL!,
      root = base.replace(/\/api$/, '');
    const resource = process.env.MCP_PUBLIC_URL!,
      redirect = 'http://127.0.0.1:47891/callback';
    const clientId = randomUUID();
    async function web(cookie: string, id: string, body?: unknown) {
      const r = await fetch(base + '/agent/authorizations/' + id, {
        method: body ? 'POST' : 'GET',
        headers: {
          Cookie: cookie,
          Origin: process.env.WEB_ORIGIN!,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json() };
    }
    async function request(scopes = ['read']) {
      const id = randomUUID(),
        verifier = randomBytes(32).toString('base64url');
      await db.agentAuthorization.create({
        data: {
          id,
          clientId,
          expiresAt: new Date(Date.now() + 600000),
          parameters: {
            redirectUri: redirect,
            resource,
            scopes,
            codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
          },
        },
      });
      return { id, verifier };
    }
    try {
      await db.agentClient.create({
        data: {
          id: clientId,
          metadata: {
            client_id: clientId,
            client_name: 'Three permissions regression',
            redirect_uris: [redirect],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
          },
        },
      });
      for (const role of ['user', 'readonly'] as const) {
        const u = await db.user.create({
          data: { username: 'oauth_levels_' + randomUUID(), passwordHash: 'unused', role },
        });
        ids.push(u.id);
        const session = randomBytes(32).toString('hex');
        await db.session.create({
          data: {
            id: createHash('sha256').update(session).digest('hex'),
            userId: u.id,
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        const cookie = 'wp_session=' + session;
        for (const level of ['read', 'draft', 'write']) {
          const a = await request();
          const preview = await web(cookie, a.id);
          assert.equal(preview.status, 200);
          assert.deepEqual(preview.data.scopes, ['read']);
          assert.deepEqual(preview.data.availableScopes, ['read', 'draft', 'write']);
          assert.equal(preview.data.canWrite, role !== 'readonly');
          const selected = level === 'read' ? ['read'] : ['read', level];
          const approved = await web(cookie, a.id, { approve: true, scopes: selected, days: 7 });
          if (role === 'readonly' && level !== 'read') {
            assert.equal(approved.status, 403);
            assert.equal(
              (await db.agentAuthorization.findUniqueOrThrow({ where: { id: a.id } })).status,
              'pending',
            );
            continue;
          }
          assert.equal(approved.status, 201, JSON.stringify(approved.data));
          const code = new URL(approved.data.redirect).searchParams.get('code')!;
          const response = await fetch(root + '/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: clientId,
              grant_type: 'authorization_code',
              code,
              code_verifier: a.verifier,
              redirect_uri: redirect,
              resource,
            }),
          });
          const token = await response.json();
          assert.equal(response.status, 200, JSON.stringify(token));
          assert.equal(token.scope, selected.join(' '));
          const row = await db.agentGrant.findFirstOrThrow({
            where: {
              userId: u.id,
              accessDigest: createHash('sha256').update(token.access_token).digest('hex'),
            },
          });
          assert.deepEqual(row.scopes, selected);
        }
        if (role === 'user') {
          const noHidden = await request();
          assert.equal(
            (
              await web(cookie, noHidden.id, {
                approve: true,
                scopes: ['read', 'write', 'hidden_read'],
              })
            ).status,
            400,
          );
          const requestedHidden = await request(['read', 'hidden_read', 'hidden_write']);
          assert.equal(
            (
              await web(cookie, requestedHidden.id, {
                approve: true,
                scopes: ['read', 'write', 'hidden_read', 'hidden_write'],
              })
            ).status,
            201,
          );
          const defaults = await request();
          assert.equal((await web(cookie, defaults.id, { approve: true })).status, 201);
          assert.deepEqual(
            (await db.agentAuthorization.findUniqueOrThrow({ where: { id: defaults.id } }))
              .parameters &&
              (
                (await db.agentAuthorization.findUniqueOrThrow({ where: { id: defaults.id } }))
                  .parameters as any
              ).scopes,
            ['read'],
          );
        }
      }
    } finally {
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.agentClient.deleteMany({ where: { id: clientId } });
      await db.$disconnect();
    }
  },
);
