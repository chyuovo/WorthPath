import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedLogin, rememberLogin } from '../src/login-preferences';

test('remembered login keeps passwords out of application storage and delegates to the browser', async (t) => {
  const values = new Map<string, string>();
  const stored: any[] = [];
  const old = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['localStorage', 'window', 'navigator'])
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() => {
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const storage = {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  class BrowserPassword {
    constructor(data: unknown) {
      Object.assign(this, data);
    }
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { isSecureContext: true, PasswordCredential: BrowserPassword },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      credentials: {
        store: async (credential: unknown) => {
          stored.push(credential);
        },
      },
    },
    configurable: true,
  });
  await rememberLogin('fixture account', 'synthetic-password-for-test', true);
  assert.deepEqual(savedLogin(), { username: 'fixture account', remember: true });
  assert.equal(
    Array.from(values.values()).some((v) => v.includes('synthetic-password-for-test')),
    false,
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, 'fixture account');
  await rememberLogin('fixture account', 'synthetic-password-for-test', false);
  assert.equal(stored.length, 1);
  assert.deepEqual(savedLogin(), { username: '', remember: false });
  // Browser support and storage failure cannot prevent a normal login.
  (window as any).isSecureContext = false;
  await rememberLogin('http fixture', 'synthetic-password-for-test', true);
  assert.equal(stored.length, 1);
  values.set('worthpath.login', 'bad json');
  assert.deepEqual(savedLogin(), { username: '', remember: false });
});
