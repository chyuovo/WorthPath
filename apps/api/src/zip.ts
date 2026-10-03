import { ZipArchive } from 'archiver';
import * as yauzl from 'yauzl';
import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { Backup } from './backup';
import { accountGroupOrder, sessionHours, overviewCards } from './validation';
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const files = [
  'settings.json',
  'currencies.json',
  'accounts.json',
  'assets.json',
  'debts.json',
  'history.json',
  'links.json',
  'rates.json',
  'icons.json',
  'transfers.json',
  'schedules.json',
] as const;
const sha = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
export function packBackup(b: Backup) {
  const metadata = b.positions.map(({ revisions, ...p }) => p);
  const data: Record<string, unknown> = {
    'settings.json': {
      baseCurrency: b.baseCurrency,
      preferences: b.preferences,
      metalPrices: b.metalPrices,
    },
    'currencies.json': b.currencies,
    'accounts.json': metadata.filter((p) => p.kind === 'account'),
    'assets.json': metadata.filter((p) => p.kind === 'asset'),
    'debts.json': metadata.filter((p) => p.kind === 'debt'),
    'history.json': b.positions.flatMap((p) =>
      p.revisions.map((r) => ({ ...r, positionId: p.id })),
    ),
    'links.json': b.links,
    'rates.json': b.rates,
    'icons.json': b.icons || [],
    'transfers.json': b.transfers || [],
    'schedules.json': b.schedules || [],
  };
  const contents = Object.fromEntries(
    files.map((name) => [name, JSON.stringify(data[name], null, 2)]),
  );
  contents['manifest.json'] = JSON.stringify(
    {
      format: 'worthpath',
      version: 8,
      exportedAt: b.exportedAt,
      files: files.map((name) => ({ name, sha256: sha(contents[name]) })),
    },
    null,
    2,
  );
  return contents;
}
export function archiveBackup(b: Backup) {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  for (const [name, contents] of Object.entries(packBackup(b))) archive.append(contents, { name });
  return archive;
}
export async function readBackupZip(input: string | Buffer): Promise<unknown> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    const callback = (err: Error | null, value?: yauzl.ZipFile) =>
      err || !value ? reject(err || Error()) : resolve(value);
    const options = { lazyEntries: true, validateEntrySizes: true, strictFileNames: true };
    if (typeof input === 'string') yauzl.open(input, options, callback);
    else yauzl.fromBuffer(input, options, callback);
  }).catch(() => {
    throw new BadRequestException('ZIP 文件无效或已损坏');
  });
  try {
    const contents = await new Promise<Map<string, Buffer>>((resolve, reject) => {
      const result = new Map<string, Buffer>();
      let expanded = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve(result));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (
          ![...files, 'manifest.json'].includes(entry.fileName as any) ||
          result.has(entry.fileName) ||
          entry.isEncrypted()
        ) {
          reject(Error());
          zip.close();
          return;
        }
        expanded += entry.uncompressedSize;
        if (expanded > MAX_EXPANDED_BYTES) {
          reject(Error('size'));
          zip.close();
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            reject(err || Error());
            zip.close();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > entry.uncompressedSize) {
              stream.destroy(Error());
            } else chunks.push(chunk);
          });
          stream.on('end', () => {
            result.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });

    const parse = (name: string) =>
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents.get(name)!));
    const manifest = z
      .object({
        format: z.literal('worthpath'),
        version: z.union([
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal(6),
          z.literal(7),
          z.literal(8),
        ]),
        exportedAt: z.iso.datetime(),
        files: z
          .array(
            z.object({ name: z.enum(files), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
          )
          .min(files.length - 3)
          .max(files.length),
      })
      .strict()
      .parse(parse('manifest.json'));
    const expected = files.filter(
      (f) =>
        (manifest.version >= 4 || f !== 'icons.json') &&
        (manifest.version >= 5 || f !== 'transfers.json') &&
        (manifest.version >= 7 || f !== 'schedules.json'),
    );
    if (
      contents.size !== expected.length + 1 ||
      new Set(manifest.files.map((f) => f.name)).size !== expected.length ||
      expected.some((name) => !manifest.files.some((f) => f.name === name))
    )
      throw Error();
    for (const f of manifest.files) if (sha(contents.get(f.name)!) !== f.sha256) throw Error();
    const settings = z
      .object({
        baseCurrency: z.string(),
        metalPrices: z.array(z.record(z.string(), z.unknown())).optional(),
        preferences: z
          .object({
            showSidebar: z.boolean().optional(),
            hiddenMenus: z.array(z.string()).optional(),
            accountGroupOrder: accountGroupOrder.optional(),
            sessionHours: sessionHours.optional(),
            requireHiddenPassword: z.boolean().optional(),
            overviewCards: overviewCards.optional(),
            includeIndependentAssets: z.boolean().optional(),
            showNotes: z.boolean().optional(),
            idleMinutes: z.number().int().min(0).max(1440),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(parse('settings.json'));
    const positions = (['accounts.json', 'assets.json', 'debts.json'] as const).flatMap(
      (name, index) => {
        const rows = z.array(z.record(z.string(), z.unknown())).parse(parse(name));
        if (rows.some((p) => p.kind !== ['account', 'asset', 'debt'][index] || 'revisions' in p))
          throw Error();
        return rows;
      },
    );
    const histories = z.array(z.record(z.string(), z.unknown())).parse(parse('history.json'));
    const ids = new Set(positions.map((p) => p.id));
    const grouped = new Map<unknown, unknown[]>();
    for (const { positionId, ...r } of histories) {
      if (!ids.has(positionId)) throw Error();
      const list = grouped.get(positionId) || [];
      list.push(r);
      grouped.set(positionId, list);
    }
    return {
      format: 'worthpath',
      version: 2,
      exportedAt: manifest.exportedAt,
      ...settings,
      currencies: parse('currencies.json'),
      positions: positions.map((p) => ({ ...p, revisions: grouped.get(p.id) || [] })),
      links: parse('links.json'),
      rates: parse('rates.json'),
      ...(manifest.version >= 5 ? { transfers: parse('transfers.json') } : {}),
      ...(manifest.version >= 7 ? { schedules: parse('schedules.json') } : {}),
      ...(manifest.version >= 4 ? { icons: parse('icons.json') } : {}),
    };
  } catch {
    throw new BadRequestException(
      '备份 ZIP 无效：请检查 JSON 文件、完整性及文件大小（上传 512 MB，解压总计 1 GB；不限制记录条数）',
    );
  } finally {
    zip.close();
  }
}
