import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { persistIconFile, readIconFile } from '../src/icon-files';
import { IconsBusinessService } from '../src/icons';
import { Database } from '../src/database';

test('icon files persist concurrently, repair damage, reject unsafe names and backfill historical pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wp_test_icon_files_'));
  const previous = process.env.ICON_STORAGE_DIR;
  process.env.ICON_STORAGE_DIR = directory;
  const data = Buffer.from('stored icon bytes');
  const hash = createHash('sha256').update(data).digest('hex');
  const file = join(directory, hash + '.png');
  try {
    await Promise.all(Array.from({ length: 5 }, () => persistIconFile(hash, data)));
    assert.deepEqual(await readFile(file), data);
    assert.deepEqual(await readdir(directory), [hash + '.png']);
    await writeFile(file, 'damaged');
    assert.deepEqual(await readIconFile(hash, data), data);
    assert.deepEqual(await readFile(file), data);
    await assert.rejects(persistIconFile('../escape', data), /Invalid icon hash/);
    await assert.rejects(persistIconFile('0'.repeat(64), data), /Invalid icon contents/);

    const historical = Buffer.from('historical icon on the second page');
    const historicalHash = createHash('sha256').update(historical).digest('hex');
    const rows = Array.from({ length: 101 }, (_, n) => ({
      id: String(n).padStart(3, '0'),
      hash: n === 100 ? historicalHash : hash,
      data: n === 100 ? historical : data,
    }));
    const database = {
      icon: {
        findMany: async (args: any) => {
          const start = args.cursor ? rows.findIndex((r) => r.id === args.cursor.id) + 1 : 0;
          return rows.slice(start, start + args.take);
        },
      },
    } as unknown as Database;
    await new IconsBusinessService(database).onModuleInit();
    assert.deepEqual(await readFile(join(directory, historicalHash + '.png')), historical);
    assert.equal(
      (await readdir(directory)).filter((name) => name.startsWith('.write-check')).length,
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.ICON_STORAGE_DIR;
    else process.env.ICON_STORAGE_DIR = previous;
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('wp_test_icon_files_'));
    await rm(directory, { recursive: true, force: true });
  }
});
