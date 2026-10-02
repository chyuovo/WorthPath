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
    preferences: { hiddenMenus: ['asset'], showNotes: false, idleMinutes: 9 },
    currencies: ['CNY'],
    icons: [],
    transfers: [],
    schedules: [],
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
    'icons.json',
    'links.json',
    'manifest.json',
    'rates.json',
    'schedules.json',
    'settings.json',
    'transfers.json',
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

test('legacy v3 ZIP remains readable without icons', async () => {
  const contents = packBackup(empty());
  delete contents['icons.json'];
  delete contents['transfers.json'];
  delete contents['schedules.json'];
  const manifest = JSON.parse(contents['manifest.json']);
  manifest.version = 3;
  manifest.files = manifest.files.filter(
    (f: { name: string }) => !['icons.json', 'transfers.json', 'schedules.json'].includes(f.name),
  );
  contents['manifest.json'] = JSON.stringify(manifest);
  const restored = validateBackup(await readBackupZip(await archive(contents)));
  assert.equal(restored.icons, undefined);
  assert.deepEqual(restored.positions, []);
});

test('legacy v4 ZIP remains readable without transfers', async () => {
  const contents = packBackup(empty());
  delete contents['transfers.json'];
  delete contents['schedules.json'];
  const manifest = JSON.parse(contents['manifest.json']);
  manifest.version = 4;
  manifest.files = manifest.files.filter(
    (f: { name: string }) => !['transfers.json', 'schedules.json'].includes(f.name),
  );
  contents['manifest.json'] = JSON.stringify(manifest);
  const restored = validateBackup(await readBackupZip(await archive(contents)));
  assert.deepEqual(restored.icons, []);
  assert.equal(restored.transfers, undefined);
  assert.equal(restored.preferences?.showNotes, false);
  assert.deepEqual(restored.preferences?.hiddenMenus, ['asset']);
});

test('ZIP v7 restores groups and schedules while v6 remains readable', async () => {
  const id = randomUUID(),
    stamp = new Date().toISOString();
  const b = validateBackup({
    ...empty(),
    positions: [
      {
        id,
        name: '账户',
        groupName: '日常',
        kind: 'account',
        side: 'asset',
        category: 'bank',
        currency: 'CNY',
        notes: '',
        archived: false,
        hidden: false,
        createdAt: stamp,
        updatedAt: stamp,
        revisions: [
          {
            id: randomUUID(),
            amount: '-10',
            date: '2026-09-01T10:00',
            notes: '',
            reason: 'balance',
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
      },
    ],
    schedules: [
      {
        id: randomUUID(),
        name: '租金',
        operation: 'expense',
        sourceId: id,
        targetId: null,
        amount: '100',
        received: '0',
        nextAt: '2026-11-01T10:00',
        intervalDays: 30,
        enabled: true,
        notes: '',
      },
    ],
  });
  const contents = packBackup(b);
  assert.deepEqual(validateBackup(await readBackupZip(await archive(contents))), b);
  delete contents['schedules.json'];
  const manifest = JSON.parse(contents['manifest.json']);
  manifest.version = 6;
  manifest.files = manifest.files.filter((f: { name: string }) => f.name !== 'schedules.json');
  contents['manifest.json'] = JSON.stringify(manifest);
  assert.equal(validateBackup(await readBackupZip(await archive(contents))).schedules, undefined);
});
