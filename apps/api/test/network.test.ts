import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkConfig, isNetworkOriginAllowed, isNetworkHostAllowed } from '../src/network';
test('network switches accept explicit deployment policy and validate cookie requirements', () => {
  const keys = [
    'NODE_ENV',
    'NETWORK_ALLOW_HTTP',
    'NETWORK_ALLOW_HTTP_REDIRECTS',
    'NETWORK_ALLOW_WILDCARD_ORIGINS',
    'NETWORK_REQUIRE_SECURE_COOKIE',
    'NETWORK_HSTS',
    'NETWORK_UPGRADE_INSECURE_REQUESTS',
    'COOKIE_SECURE',
    'COOKIE_SAME_SITE',
  ];
  const before = { ...process.env };
  try {
    for (const k of keys) delete process.env[k];
    process.env.NODE_ENV = 'production';
    assert.equal(networkConfig().allowHttp, false);
    assert.equal(networkConfig().requireSecureCookie, true);
    process.env.NETWORK_ALLOW_HTTP = 'true';
    process.env.NETWORK_ALLOW_WILDCARD_ORIGINS = 'true';
    process.env.NETWORK_ALLOW_HTTP_REDIRECTS = 'true';
    assert.equal(networkConfig().allowHttp, true);
    assert.equal(networkConfig().allowWildcardOrigins, true);
    assert.equal(networkConfig().allowHttpRedirects, true);
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_SAME_SITE = 'none';
    assert.throws(() => networkConfig(), /requires/);
    process.env.COOKIE_SAME_SITE = 'strict';
    process.env.NETWORK_ALLOW_HTTP = 'typo';
    assert.throws(() => networkConfig(), /true or false/);
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
});
test('Host and Origin lists accept all networks or enforce exact configured entries', () => {
  assert.equal(isNetworkOriginAllowed('http://192.0.2.15:5173', '*', true), true);
  assert.equal(isNetworkOriginAllowed('https://elsewhere.example', '*', false), false);
  assert.equal(isNetworkOriginAllowed('null', '*', true), false);
  assert.equal(isNetworkOriginAllowed('file:///tmp', '*', true), false);
  assert.equal(
    isNetworkOriginAllowed('http://a.example', 'http://a.example, https://b.example', false),
    true,
  );
  assert.equal(isNetworkOriginAllowed('http://a.example.evil', 'http://a.example', false), false);
  assert.equal(isNetworkHostAllowed('192.0.2.15:3100', '*'), true);
  assert.equal(isNetworkHostAllowed('example.com:3100', 'example.com:3100'), true);
  assert.equal(isNetworkHostAllowed('example.com:3101', 'example.com:3100'), false);
  assert.equal(isNetworkHostAllowed(undefined, '*'), false);
});
