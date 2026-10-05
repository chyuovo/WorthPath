import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function target(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid icon hash');
  const directory = process.env.ICON_STORAGE_DIR?.trim();
  return directory ? join(resolve(directory), hash + '.png') : undefined;
}

export async function initializeIconDirectory() {
  const configured = process.env.ICON_STORAGE_DIR?.trim();
  if (!configured) return;
  const directory = resolve(configured);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const probe = join(directory, '.write-check-' + randomBytes(16).toString('hex'));
  await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
  await unlink(probe);
}

// Immutable content-addressed files can be shared by multiple icon records.
// Keep the database copy for existing installations and self-contained ZIP backups.
export async function persistIconFile(hash: string, data: Buffer) {
  const file = target(hash);
  if (!file) return;
  if (digest(data) !== hash) throw Error('Invalid icon contents');
  try {
    if (digest(await readFile(file)) === hash) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(resolve(process.env.ICON_STORAGE_DIR!.trim()), { recursive: true, mode: 0o750 });
  const temporary = file + '.' + randomBytes(16).toString('hex') + '.tmp';
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, file);
    } catch (error) {
      // Windows may reject replacing a file another upload has just published.
      // Accept only an already complete file with exactly the expected content.
      const existing = await readFile(file).catch(() => undefined);
      if (!existing || digest(existing) !== hash) throw error;
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function readIconFile(hash: string, databaseData: Buffer) {
  const file = target(hash);
  if (!file) return databaseData;
  try {
    const data = await readFile(file);
    if (digest(data) === hash) return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await persistIconFile(hash, databaseData);
  return databaseData;
}
