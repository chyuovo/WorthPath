import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import { validateBackup } from '../src/backup';
import { packBackup, readBackupZip } from '../src/zip';
const empty = () =>
  validateBackup({
    format: 'worthpath',
    version: 9,
    exportedAt: new Date().toISOString(),
    baseCurrency: 'CNY',
    preferences: {
      hiddenMenus: ['asset'],
      showNotes: false,
      idleMinutes: 9,
      accountGroupOrder: [],
      sessionHours: 168,
      requireHiddenPassword: true,
      overviewCards: ['net'],
      includeIndependentAssets: true,
    },
    currencies: ['CNY'],
    icons: [],
    transfers: [],
    schedules: [],
    metalPrices: [],
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
  assert.doesNotMatch(
    Object.values(contents).join('\n'),
    /"(?:passwordHash|password|token|sessionId|userId|accessDigest|refreshDigest)"/i,
  );
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
    groupName: '',
    iconId: null,
    included: true,
    importedFromId: null,
    metalType: null,
    metalGrams: null,
    metalCostPerGram: null,
    metalPurity: '1',
    autoValuation: false,
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

test('all historical ZIP versions and JSON formats are rejected', async () => {
  for (const version of [3, 4, 5, 6, 7, 8]) {
    const contents = packBackup(empty());
    const manifest = JSON.parse(contents['manifest.json']);
    manifest.version = version;
    contents['manifest.json'] = JSON.stringify(manifest);
    await assert.rejects(async () => readBackupZip(await archive(contents)));
  }
  for (const version of [1, 2, 3]) assert.throws(() => validateBackup({ ...empty(), version }));
});
test('current backups require complete settings and metadata, with no legacy defaults', async () => {
  const b = empty();
  b.preferences.accountGroupOrder = ['日常', ''];
  assert.deepEqual(validateBackup(await readBackupZip(await archive(packBackup(b)))), b);
  for (const key of Object.keys(b.preferences)) {
    const incomplete = structuredClone(b);
    delete (incomplete.preferences as any)[key];
    assert.throws(() => validateBackup(incomplete));
  }
  for (const key of ['icons', 'transfers', 'schedules', 'metalPrices']) {
    const incomplete = structuredClone(b);
    delete (incomplete as any)[key];
    assert.throws(() => validateBackup(incomplete));
  }
  assert.throws(() =>
    validateBackup({ ...b, preferences: { ...b.preferences, showSidebar: false } }),
  );
});
