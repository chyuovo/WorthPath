import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const names = git('diff', '--cached', '--name-only').trim().split('\n').filter(Boolean);
if (
  names.some(
    (n) =>
      /(^|\/)(\.env(?:\..*)?|node_modules|dist|coverage)(\/|$)/.test(n) &&
      !n.endsWith('.env.example'),
  ) ||
  names.some((n) => /\.(db|sqlite|log)$/.test(n))
)
  throw Error('Blocked: forbidden file staged');
const diff = git('diff', '--cached', '--no-ext-diff');
if (existsSync('apps/api/.env')) {
  const text = readFileSync('apps/api/.env', 'utf8'),
    value = text.match(/^DATABASE_URL=["']?([^"'\r\n]+)/m)?.[1];
  if (value) {
    const u = new URL(value);
    for (const s of [decodeURIComponent(u.password), u.hostname])
      if (s.length >= 6 && diff.includes(s))
        throw Error('Blocked: local credential or connection metadata in staged changes');
  }
}
if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}/.test(diff))
  throw Error('Blocked: secret-like material staged');
console.log(
  `Staged review passed: ${names.length} files; local environment and build artifacts excluded.`,
);
