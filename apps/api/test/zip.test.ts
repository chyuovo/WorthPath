import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import { validateBackup } from '../src/backup';
import { packBackup, readBackupZip } from '../src/zip';
const empty = () =>
  validateBackup({
    format: 'worthpath',
    version: 2,
    exportedAt: new Date().toISOString(),
    baseCurrency: 'CNY',
    preferences: { showSidebar: false, idleMinutes: 9 },
    currencies: ['CNY'],
    positions: [],
    rates: [],
    links: [],
  });
async function archive(contents: Record<string, string>) {
  const zip = new ZipArchive({ zlib: { level: 1 } }),
    chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.on('data', (chunk) => chunks.push(chunk));
    zip.on('end', () => resolve(Buffer.concat(chunks)));
    zip.on('error', reject);
  });
  for (const [name, data] of Object.entries(contents)) zip.append(data, { name });
  await zip.finalize();
  return done;
}
test('ZIP contains separate JSON files and restores settings without authentication data', async () => {
  const b = empty(),
    contents = packBackup(b);
  assert.deepEqual(Object.keys(contents).sort(), [
    'accounts.json',
    'assets.json',
    'currencies.json',
    'debts.json',
    'history.json',
    'links.json',
    'manifest.json',
    'rates.json',
    'settings.json',
  ]);
  assert.doesNotMatch(JSON.stringify(contents), /password|token|session|userId/i);
  assert.deepEqual(validateBackup(await readBackupZip(await archive(contents))), b);
});
test('ZIP rejects incomplete files, tampering, unknown entries and invalid entry names', async () => {
  const contents = packBackup(empty());
  await assert.rejects(async () =>
    readBackupZip(await archive({ ...contents, 'settings.json': '{}' })),
  );
  const missing = { ...contents };
  delete missing['history.json'];
  await assert.rejects(async () => readBackupZip(await archive(missing)));
  await assert.rejects(async () =>
    readBackupZip(await archive({ ...contents, 'unexpected.json': '[]' })),
  );
  await assert.rejects(() => readBackupZip(Buffer.from('invalid zip')));
});
test('backup accepts over 1000 positions, 10000 revisions per position and 20000 total revisions', () => {
  const stamp = new Date().toISOString();
  const position = (count: number) => ({
    id: randomUUID(),
    name: 'count acceptance',
    kind: 'asset',
    side: 'asset',
    category: 'other',
    currency: 'CNY',
    notes: '',
    archived: false,
    hidden: false,
    createdAt: stamp,
    updatedAt: stamp,
    revisions: Array.from({ length: count }, (_, n) => ({
      id: randomUUID(),
      sequence: n + 1,
      amount: '1',
      date: '2026-09-01T09:17',
      notes: '',
      reason: 'valuation',
      createdAt: stamp,
      updatedAt: stamp,
    })),
  });
  const b = validateBackup({
    ...empty(),
    positions: [position(10001), ...Array.from({ length: 1000 }, () => position(11))],
  });
  assert.equal(b.positions.length, 1001);
  assert.equal(
    b.positions.reduce((n, p) => n + p.revisions.length, 0),
    21001,
  );
});
