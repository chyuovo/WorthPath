import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOAuth, urls, webLink } from '../src/mcp/oauth';

test('HTTP resources, web links and client redirects work beyond loopback in development', async () => {
  const before = { ...process.env };
  try {
    process.env.NODE_ENV = 'development';
    process.env.NETWORK_ALLOW_HTTP = 'true';
    process.env.NETWORK_ALLOW_HTTP_REDIRECTS = 'true';
    process.env.MCP_PUBLIC_URL = 'http://192.0.2.10:3100/mcp';
    process.env.MCP_WEB_URL = 'http://192.0.2.10:5173';
    assert.equal(urls().issuer.href, 'http://192.0.2.10:3100/');
    assert.equal(new URL(webLink('agent_authorization', 'test-id')).pathname, '/agent/authorize');
    const db: any = { agentClient: { count: async () => 0, create: async () => ({}) } };
    const oauth = new AgentOAuth(db);
    await oauth.clientsStore.registerClient({
      redirect_uris: ['http://192.0.2.20:47891/callback'],
      token_endpoint_auth_method: 'none',
    });
    process.env.MCP_PUBLIC_URL = 'ftp://192.0.2.10/mcp';
    assert.throws(() => urls(), /HTTPS/);
    process.env.MCP_PUBLIC_URL = 'http://192.0.2.10:3100/mcp';
    process.env.MCP_WEB_URL = 'file:///tmp/test';
    assert.throws(() => urls(), /HTTPS/);
    await assert.rejects(() =>
      oauth.clientsStore.registerClient({
        redirect_uris: ['file:///tmp/test'],
        token_endpoint_auth_method: 'none',
      }),
    );
  } finally {
    for (const k of [
      'NODE_ENV',
      'MCP_PUBLIC_URL',
      'MCP_WEB_URL',
      'NETWORK_ALLOW_HTTP',
      'NETWORK_ALLOW_HTTP_REDIRECTS',
    ]) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});

test('production requires HTTPS for configured endpoints and rejects non-loopback HTTP callbacks', async () => {
  const before = { ...process.env };
  try {
    process.env.NODE_ENV = 'production';
    process.env.NETWORK_ALLOW_HTTP = 'false';
    process.env.NETWORK_ALLOW_HTTP_REDIRECTS = 'false';
    process.env.MCP_PUBLIC_URL = 'http://192.0.2.10:3100/mcp';
    process.env.MCP_WEB_URL = 'https://worthpath.example';
    assert.throws(() => urls(), /HTTPS/);
    process.env.MCP_PUBLIC_URL = 'https://api.worthpath.example/mcp';
    process.env.MCP_WEB_URL = 'http://192.0.2.10:5173';
    assert.throws(() => urls(), /HTTPS/);
    process.env.MCP_WEB_URL = 'https://worthpath.example';
    assert.equal(urls().web.protocol, 'https:');
    const oauth = new AgentOAuth({
      agentClient: { count: async () => 0, create: async () => ({}) },
    } as any);
    await assert.rejects(() =>
      oauth.clientsStore.registerClient({
        redirect_uris: ['http://192.0.2.20:47891/callback'],
        token_endpoint_auth_method: 'none',
      }),
    );
    await oauth.clientsStore.registerClient({
      redirect_uris: ['http://127.0.0.1:47891/callback'],
      token_endpoint_auth_method: 'none',
    });
  } finally {
    for (const k of [
      'NODE_ENV',
      'MCP_PUBLIC_URL',
      'MCP_WEB_URL',
      'NETWORK_ALLOW_HTTP',
      'NETWORK_ALLOW_HTTP_REDIRECTS',
    ]) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});
