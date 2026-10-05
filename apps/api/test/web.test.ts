import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { installWeb } from '../src/web';

test('combined web serves pages/assets without swallowing API, MCP, OAuth or missing assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worthpath-web-'));
  const app = express();
  let server: ReturnType<typeof app.listen> | undefined;
  try {
    assert.equal(installWeb(app, join(dir, 'missing')), false);
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html>WorthPath test page</html>');
    await writeFile(join(dir, 'assets', 'app.js'), 'window.worthpath = true;');
    assert.equal(installWeb(app, dir), true);
    // Register downstream service routes to detect accidental web interception.
    for (const path of [
      '/api/probe',
      '/mcp',
      '/authorize',
      '/token',
      '/register',
      '/revoke',
      '/.well-known/oauth-authorization-server',
    ]) {
      app.all(path, (_req, res) => res.status(401).json({ service: path }));
    }
    app.use((_req, res) => res.status(404).json({ missing: true }));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of [
      '/',
      '/?agent_operation=test',
      '/agent/authorize?agent_authorization=test',
      '/agent/operation',
    ]) {
      const result = await fetch(base + path);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type') || '', /text\/html/);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.match(await result.text(), /WorthPath test page/);
    }
    const head = await fetch(base + '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.match(await (await fetch(base + '/assets/app.js')).text(), /window.worthpath/);
    for (const path of ['/assets/missing.js', '/api/unknown', '/unknown']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 404);
    for (const path of [
      '/api/probe',
      '/mcp',
      '/authorize',
      '/token',
      '/register',
      '/revoke',
      '/.well-known/oauth-authorization-server',
    ]) {
      for (const method of ['GET', 'POST']) {
        const result = await fetch(base + path, { method });
        assert.equal(result.status, 401);
        assert.deepEqual(await result.json(), { service: path });
      }
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(dir, { recursive: true, force: true });
  }
});
