import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMcpHost } from '../src/mcp/hosts';

const resource = new URL('https://worthpath.example/mcp');

test('default Host protection preserves canonical and development hosts', () => {
  assert.equal(isAllowedMcpHost('worthpath.example', resource, undefined, true), true);
  const local = new URL('http://localhost:3100/mcp');
  assert.equal(isAllowedMcpHost('127.0.0.1:3100', local, undefined, false), true);
  assert.equal(isAllowedMcpHost('localhost:3100', local, '', false), true);
  assert.equal(isAllowedMcpHost('127.0.0.1:3100', local, '', true), false);
  assert.equal(isAllowedMcpHost('198.18.0.1:3100', resource, undefined, false), false);
});

test('explicit Host list replaces defaults and matches exact ports', () => {
  const configured = ' 198.18.0.1:3100, HOST.example:3100, [::1]:3100 ';
  for (const host of ['198.18.0.1:3100', 'host.example:3100', '[::1]:3100'])
    assert.equal(isAllowedMcpHost(host, resource, configured, true), true);
  for (const host of ['198.18.0.1:3101', 'worthpath.example', 'host.example:3100.evil'])
    assert.equal(isAllowedMcpHost(host, resource, configured, true), false);
});

test('wildcard allows all hosts but still rejects a missing Host', () => {
  for (const host of ['198.18.0.1:3100', '192.168.1.2:3100', '[2001:db8::1]:3100', 'example.com'])
    assert.equal(isAllowedMcpHost(host, resource, '*', false), true);
  assert.equal(isAllowedMcpHost(undefined, resource, '*', false), false);
  assert.equal(isAllowedMcpHost('', resource, '*', false), false);
  assert.equal(isAllowedMcpHost('example.com', resource, '*.example.com', false), false);
});
