import { scheduleInput } from './schedules';
import { movementDeltas } from './movement';
import { pairedReasons } from './validation';
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  BadRequestException,
  ConflictException,
  UploadedFile,
  UseInterceptors,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { tmpdir } from 'node:os';
import { unlink, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveBackup, readBackupZip, MAX_UPLOAD_BYTES } from './zip';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Database } from './database';
import { UserRequest } from './auth';
import {
  positionInput,
  positionMeta,
  currency,
  revisionInput,
  rateInput,
  hiddenMenus,
  transferInput,
} from './validation';
import { createHash } from 'node:crypto';
import { toBusinessDate } from './validation';
import { iconName, validateStoredIcon } from './icons';
import { day, businessTime } from './calculation';
const timestamp = z.iso
  .datetime()
  .refine(
    (s) => s >= '1900-01-01T00:00:00.000Z' && new Date(s).getTime() <= Date.now() + 60000,
    '创建和更新时间无效',
  );
const record = positionMeta
  .extend({
    kind: z.enum(['account', 'asset', 'debt']),
    side: z.enum(['asset', 'liability']),
    currency,
    id: z.string().uuid(),
    importedFromId: z.string().uuid().nullable().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revisions: z
      .array(
        revisionInput.extend({
          id: z.string().uuid(),
          sequence: z.number().int().positive().max(2147483647).optional(),
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      )
      .min(1),
  })
  .strict();
const backupSchema = z
  .object({
    format: z.literal('worthpath'),
    version: z.union([z.literal(1), z.literal(2)]),
    exportedAt: z.iso.datetime(),
    baseCurrency: currency,
    currencies: z.array(currency).max(10),
    preferences: z
      .object({
        showSidebar: z.boolean().optional(),
        hiddenMenus: hiddenMenus.optional(),
        showNotes: z.boolean().optional(),
        idleMinutes: z.number().int().min(0).max(1440),
      })
      .strict()
      .optional(),
    icons: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: iconName,
            shared: z.boolean(),
            image: z.string().max(3 * 1024 * 1024),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .optional(),
    transfers: z
      .array(
        transferInput.safeExtend({
          id: z.string().uuid(),
          importedFromId: z.string().uuid().nullable().optional(),
          sourceRevisionId: z.string().uuid(),
          targetRevisionId: z.string().uuid(),
          sourceCurrency: currency,
          targetCurrency: currency,
          createdAt: timestamp,
        }),
      )
      .optional(),
    schedules: z
      .array(
        scheduleInput.safeExtend({
          id: z.string().uuid(),
          importedFromId: z.string().uuid().nullable().optional(),
          enabled: z.boolean(),
          completed: z.boolean().default(false),
        }),
      )
      .optional(),
    positions: z.array(record),
    links: z.array(z.object({ sourceId: z.string().uuid(), targetId: z.string().uuid() }).strict()),
    rates: z.array(rateInput.safeExtend({ source: z.enum(['manual', 'frankfurter']) })),
  })
  .strict();
export type Backup = z.infer<typeof backupSchema>;
export function validateBackup(raw: unknown) {
  const b = backupSchema.parse(raw),
    ids = new Map(b.positions.map((p) => [p.id, p]));
  if (ids.size !== b.positions.length) throw new BadRequestException('重复项目 ID');
  const origins = b.positions.map((p) => p.importedFromId || p.id);
  if (new Set(origins).size !== origins.length) throw new BadRequestException('备份内包含重复项目');
  const iconIds = new Set((b.icons || []).map((i) => i.id));
  if (
    iconIds.size !== (b.icons || []).length ||
    b.positions.some((p) => p.iconId && !iconIds.has(p.iconId))
  )
    throw new BadRequestException('图标关联无效');
  const revisionIds = new Set<string>();
  for (const p of b.positions) {
    positionInput.parse({
      name: p.name,
      category: p.category,
      groupName: p.groupName,
      kind: p.kind,
      side: p.side,
      currency: p.currency,
      notes: p.notes,
      archived: p.archived,
      hidden: p.hidden,
      amount: '0',
      date: p.revisions[0].date,
    });
    const sequences = new Set<number>();
    for (const r of p.revisions) {
      if (revisionIds.has(r.id) || (r.sequence !== undefined && sequences.has(r.sequence)))
        throw new BadRequestException('重复历史记录');
      if (r.sequence !== undefined) sequences.add(r.sequence);
      revisionIds.add(r.id);
    }
    if (!b.currencies.includes(p.currency)) throw new BadRequestException('币种清单不完整');
  }
  for (const p of b.positions)
    if (
      (p.kind !== 'account' || p.side !== 'asset') &&
      p.revisions.some((r) => r.amount.startsWith('-'))
    )
      throw new BadRequestException('仅资产账户支持负余额');
  const planIds = new Set<string>();
  for (const plan of b.schedules || []) {
    const source = ids.get(plan.sourceId),
      target = plan.targetId ? ids.get(plan.targetId) : null;
    if (
      planIds.has(plan.importedFromId || plan.id) ||
      !source ||
      source.kind !== 'account' ||
      source.side !== 'asset' ||
      (plan.operation === 'expense'
        ? !!plan.targetId
        : !target ||
          target.kind !== 'account' ||
          target.side !== 'asset' ||
          (source.currency === target.currency && !new Decimal(plan.amount).eq(plan.received)))
    )
      throw new BadRequestException('计划账户关联无效');
    planIds.add(plan.importedFromId || plan.id);
  }
  const transferIds = new Set<string>(),
    usedRevisions = new Set<string>();
  for (const t of b.transfers || []) {
    const source = ids.get(t.sourceId),
      target = ids.get(t.targetId);
    const origin = t.importedFromId || t.id;
    if (
      transferIds.has(origin) ||
      !source ||
      !target ||
      source.kind !== 'account' ||
      source.side !== 'asset' ||
      (t.operation === 'transfer'
        ? target.kind !== 'account' || target.side !== 'asset'
        : target.kind !== 'debt' ||
          target.side !== (['borrow', 'repay'].includes(t.operation) ? 'liability' : 'asset')) ||
      source.currency !== t.sourceCurrency ||
      target.currency !== t.targetCurrency
    )
      throw new BadRequestException('转账关联无效');
    transferIds.add(origin);
    if (t.sourceCurrency === t.targetCurrency && !new Decimal(t.amount).eq(t.received))
      throw new BadRequestException('同币种转账金额不一致');
    const deltas = movementDeltas(t.operation, t.amount, t.received, t.fee);
    for (const [p, revId, reason, delta] of [
      [source, t.sourceRevisionId, deltas.sourceReason, deltas.source],
      [target, t.targetRevisionId, deltas.targetReason, deltas.target],
    ] as const) {
      const ordered = [...p.revisions].sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          (a.sequence || 0) - (b.sequence || 0) ||
          a.createdAt.localeCompare(b.createdAt),
      );
      const index = ordered.findIndex((r) => r.id === revId),
        current = ordered[index];
      if (
        usedRevisions.has(revId) ||
        index < 1 ||
        !current ||
        current.reason !== reason ||
        current.date !== t.date ||
        !new Decimal(current.amount).minus(ordered[index - 1].amount).eq(delta)
      )
        throw new BadRequestException('转账历史与双方金额不一致');
      usedRevisions.add(revId);
    }
  }
  if (
    b.positions.some((p) =>
      p.revisions.some((r) => pairedReasons.includes(r.reason) && !usedRevisions.has(r.id)),
    )
  )
    throw new BadRequestException('缺少配对转账记录');
  const links = new Set<string>();
  for (const l of b.links) {
    const s = ids.get(l.sourceId),
      t = ids.get(l.targetId),
      key = l.sourceId + l.targetId;
    if (!s || !t || s.kind !== 'debt' || t.kind === 'debt' || s.id === t.id || links.has(key))
      throw new BadRequestException('关联关系无效');
    links.add(key);
  }
  const rates = new Set<string>();
  for (const r of b.rates) {
    const key = `${r.currency}/${r.baseCurrency}/${r.date}`;
    if (rates.has(key)) throw new BadRequestException('重复汇率');
    rates.add(key);
    if (!b.currencies.includes(r.currency) || !b.currencies.includes(r.baseCurrency))
      throw new BadRequestException('币种清单不完整');
  }
  if (!b.currencies.includes(b.baseCurrency)) throw new BadRequestException('本位币清单不完整');
  return b;
}
@Controller('api/backup')
export class BackupController implements OnModuleDestroy, OnModuleInit {
  private uploads = new Map<
    string,
    { sessionId: string; userId: string; path: string; expires: number }
  >();
  private cleaner = setInterval(() => void this.prune(), 60000).unref();
  private async prune(all = false) {
    for (const [token, v] of this.uploads)
      if (all || v.expires < Date.now()) {
        this.uploads.delete(token);
        await unlink(v.path).catch(() => {});
      }
    // Remove only this application's expired uploads, including files left by a restart.
    for (const name of await readdir(tmpdir()).catch(() => [])) {
      if (!/^worthpath-import-[a-f0-9-]{36}\.zip$/.test(name)) continue;
      const path = join(tmpdir(), name),
        info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 15 * 60000) await unlink(path).catch(() => {});
    }
  }
  async onModuleDestroy() {
    clearInterval(this.cleaner);
    await this.prune(true);
  }
  private async uploadedData(path: string) {
    const handle = await open(path, 'r');
    const prefix = Buffer.alloc(2);
    try {
      await handle.read(prefix, 0, 2, 0);
    } finally {
      await handle.close();
    }
    return prefix.toString() === 'PK'
      ? readBackupZip(path)
      : JSON.parse(await readFile(path, 'utf8'));
  }
  constructor(private db: Database) {}
  private async data(
    userId: string,
    client: Database | Prisma.TransactionClient = this.db,
  ): Promise<Backup> {
    const [user, ps, rates] = await Promise.all([
      client.user.findUniqueOrThrow({
        where: { id: userId },
        select: { baseCurrency: true, hiddenMenus: true, showNotes: true, idleMinutes: true },
      }),
      client.position.findMany({
        where: { userId },
        include: {
          revisions: { orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }] },
          outgoing: true,
        },
      }),
      client.exchangeRate.findMany({ where: { userId } }),
    ]);
    const positions = ps.map((p) => ({
      id: p.id,
      iconId: p.iconId,
      importedFromId: p.importedFromId,
      name: p.name,
      kind: p.kind,
      side: p.side,
      category: p.category,
      groupName: p.groupName,
      currency: p.currency,
      notes: p.notes,
      archived: p.archived,
      hidden: p.hidden,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      revisions: p.revisions.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        amount: r.amount.toString(),
        date: businessTime(r.effectiveDate),
        notes: r.notes,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }));
    const icons = await client.icon.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            id: { in: ps.flatMap((p) => (p.iconId ? [p.iconId] : [])) },
            OR: [{ shared: true }, { ownerId: userId }],
          },
        ],
      },
    });
    const transfers = await client.transfer.findMany({ where: { userId } });
    const schedules = await client.schedule.findMany({ where: { userId } });
    return backupSchema.parse({
      format: 'worthpath',
      version: 2,
      exportedAt: new Date().toISOString(),
      baseCurrency: user.baseCurrency,
      preferences: {
        hiddenMenus: user.hiddenMenus.split(',').filter(Boolean),
        showNotes: user.showNotes,
        idleMinutes: user.idleMinutes,
      },
      currencies: [
        ...new Set([
          user.baseCurrency,
          ...ps.map((p) => p.currency),
          ...rates.flatMap((r) => [r.currency, r.baseCurrency]),
        ]),
      ],
      icons: icons.map((i) => ({
        id: i.id,
        name: i.name,
        shared: i.shared,
        hash: i.hash,
        image: Buffer.from(i.data).toString('base64'),
      })),
      transfers: transfers.map(({ userId, effectiveDate, ...t }) => ({
        ...t,
        amount: t.amount.toString(),
        received: t.received.toString(),
        fee: t.fee.toString(),
        date: businessTime(effectiveDate),
        createdAt: t.createdAt.toISOString(),
      })),
      schedules: schedules.map(({ userId, ...v }) => ({
        ...v,
        amount: v.amount.toString(),
        received: v.received.toString(),
        nextAt: businessTime(v.nextAt),
      })),
      positions,
      links: ps.flatMap((p) =>
        p.outgoing.map((l) => ({ sourceId: l.sourceId, targetId: l.targetId })),
      ),
      rates: rates.map((r) => ({
        currency: r.currency,
        baseCurrency: r.baseCurrency,
        date: day(r.date),
        rate: r.rate.toString(),
        source: r.source,
      })),
    });
  }
  @Get() async download(@Req() r: UserRequest, @Res() res: Response) {
    const b = await this.db.$transaction(
      async (tx) => {
        const b = await this.data(r.userId, tx);
        await tx.session.update({
          where: { id: r.sessionId },
          data: {
            backupDigest: this.fingerprint(b),
            backupExpiresAt: new Date(Date.now() + 10 * 60000),
          },
        });
        return b;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="worthpath-${b.exportedAt.slice(0, 10)}.zip"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/zip');
    const archive = archiveBackup(b);
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    await archive.finalize().catch(() => res.destroy());
  }
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, _file, cb) => cb(null, 'worthpath-import-' + randomUUID() + '.zip'),
      }),
      limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 0 },
    }),
  )
  async upload(@Req() r: UserRequest, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('请选择 ZIP 备份文件');
    try {
      const b = validateBackup(await this.uploadedData(file.path));
      const result = await this.preview(r, b);
      for (const [token, v] of this.uploads)
        if (v.userId === r.userId) {
          this.uploads.delete(token);
          await unlink(v.path).catch(() => {});
        }
      const token = randomUUID();
      this.uploads.set(token, {
        sessionId: r.sessionId,
        userId: r.userId,
        path: file.path,
        expires: Date.now() + 15 * 60000,
      });
      return { ...result, token };
    } catch (e) {
      await unlink(file.path).catch(() => {});
      throw e;
    }
  }
  async onModuleInit() {
    await this.prune();
  }
  @Post('import-file') async importFile(@Req() r: UserRequest, @Body() raw: unknown) {
    const { token } = z
      .object({ confirmed: z.literal(true), token: z.string().uuid() })
      .strict()
      .parse(raw);
    const v = this.uploads.get(token);
    if (!v || v.userId !== r.userId || v.sessionId !== r.sessionId || v.expires < Date.now())
      throw new BadRequestException('导入预览已失效，请重新选择备份');
    this.uploads.delete(token);
    try {
      return await this.restore(r, { confirmed: true, backup: await this.uploadedData(v.path) });
    } finally {
      await unlink(v.path).catch(() => {});
    }
  }
  private fingerprint(b: Backup) {
    const { exportedAt, ...data } = structuredClone(b);
    data.positions.sort((a, b) => a.id.localeCompare(b.id));
    for (const p of data.positions) p.revisions.sort((a, b) => a.id.localeCompare(b.id));
    data.links.sort((a, b) => (a.sourceId + a.targetId).localeCompare(b.sourceId + b.targetId));
    data.rates.sort((a, b) =>
      (a.currency + a.baseCurrency + a.date).localeCompare(b.currency + b.baseCurrency + b.date),
    );
    data.currencies.sort();
    data.transfers?.sort((a, b) => a.id.localeCompare(b.id));
    data.icons?.sort((a, b) => a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }
  @Get('clear-status') async clearStatus(@Req() r: UserRequest) {
    const s = await this.db.session.findUniqueOrThrow({ where: { id: r.sessionId } });
    return { ready: !!s.backupDigest && !!s.backupExpiresAt && +s.backupExpiresAt > Date.now() };
  }
  @Post('clear') async clear(@Req() r: UserRequest, @Body() raw: unknown) {
    z.object({ confirmation: z.literal('确定清空') })
      .strict()
      .parse(raw);
    return this.db.$transaction(
      async (tx) => {
        const s = await tx.session.findUniqueOrThrow({ where: { id: r.sessionId } });
        if (!s.backupDigest || !s.backupExpiresAt || +s.backupExpiresAt <= Date.now())
          throw new BadRequestException('请先下载当前账号备份，再进入下一步（10 分钟内有效）');
        if (this.fingerprint(await this.data(r.userId, tx)) !== s.backupDigest)
          throw new ConflictException('数据已变化，请重新下载备份');
        await tx.schedule.deleteMany({ where: { userId: r.userId } });
        await tx.position.deleteMany({ where: { userId: r.userId } });
        await tx.icon.deleteMany({ where: { ownerId: r.userId, shared: false } });
        await tx.exchangeRate.deleteMany({ where: { userId: r.userId } });
        await tx.session.updateMany({
          where: { userId: r.userId },
          data: { backupDigest: null, backupExpiresAt: null, revealUntil: null },
        });
        return { ok: true };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300000 },
    );
  }
  @Post('preview') async preview(@Req() r: UserRequest, @Body() raw: unknown) {
    const b = validateBackup(raw),
      existing = await this.data(r.userId);
    for (const i of b.icons || []) await validateStoredIcon(i.image, i.hash);
    this.conflicts(b, existing);
    return {
      positions: b.positions.length,
      revisions: b.positions.reduce((n, p) => n + p.revisions.length, 0),
      rates: b.rates.length,
      icons: (b.icons || []).length,
      transfers: (b.transfers || []).length,
      schedules: (b.schedules || []).length,
      baseCurrency: b.baseCurrency,
      currentBaseCurrency: existing.baseCurrency,
      message:
        '只追加新项目并重建关联，相同汇率保留。不会覆盖已有项目。已有本位币保留，空账户恢复备份本位币和个人设置。确认后以事务导入，备份中的图标恢复为私有，不会自动发布到共享库。',
    };
  }
  private conflicts(b: Backup, existing: Backup) {
    const ids = new Set(
      existing.positions.flatMap((p) => [p.id, p.importedFromId].filter(Boolean)),
    );
    if (b.positions.some((p) => ids.has(p.id) || ids.has(p.importedFromId || p.id)))
      throw new ConflictException('包含已有或重复项目，请勿重复导入；首版只支持追加新项目');
    for (const rate of b.rates) {
      const e = existing.rates.find(
        (r) =>
          r.currency === rate.currency &&
          r.baseCurrency === rate.baseCurrency &&
          r.date === rate.date,
      );
      if (e && !new Decimal(e.rate).eq(rate.rate))
        throw new ConflictException('已有同日汇率与备份冲突，未修改数据');
    }
  }
  @Post('import') async restore(@Req() r: UserRequest, @Body() raw: unknown) {
    const { backup } = z
        .object({ confirmed: z.literal(true), backup: backupSchema })
        .strict()
        .parse(raw),
      b = validateBackup(backup);
    const iconData = new Map<string, Buffer>();
    for (const i of b.icons || []) iconData.set(i.id, await validateStoredIcon(i.image, i.hash));
    return this.db.$transaction(
      async (tx) => {
        const ps = await tx.position.findMany({
            where: { userId: r.userId },
            include: { revisions: true },
          }),
          rs = await tx.exchangeRate.findMany({ where: { userId: r.userId } });
        const existing = {
          positions: ps.map((p) => ({
            ...p,
            revisions: p.revisions.map((v) => ({
              ...v,
              amount: v.amount.toString(),
              date: day(v.effectiveDate),
            })),
          })),
          rates: rs.map((v) => ({ ...v, rate: v.rate.toString(), date: day(v.date) })),
        } as unknown as Backup;
        this.conflicts(b, existing);
        const iconMapping = new Map<string, string>();
        for (const i of b.icons || []) {
          const row = await tx.icon.upsert({
            where: { ownerId_hash_shared: { ownerId: r.userId, hash: i.hash, shared: false } },
            create: {
              ownerId: r.userId,
              name: i.name,
              hash: i.hash,
              shared: false,
              data: new Uint8Array(iconData.get(i.id)!),
            },
            update: {},
          });
          iconMapping.set(i.id, row.id);
        }
        const mapping = new Map<string, string>(),
          revisionMapping = new Map<string, string>();
        for (const p of b.positions) {
          const row = await tx.position.create({
            data: {
              userId: r.userId,
              importedFromId: p.importedFromId || p.id,
              iconId: p.iconId ? iconMapping.get(p.iconId) : null,
              name: p.name,
              kind: p.kind,
              side: p.side,
              category: p.category,
              groupName: p.groupName,
              currency: p.currency,
              notes: p.notes,
              archived: p.archived,
              hidden: p.hidden,
              createdAt: new Date(p.createdAt),
              updatedAt: new Date(p.updatedAt),
              revisions: {
                create: [...p.revisions]
                  .sort(
                    (a, b) =>
                      a.date.localeCompare(b.date) ||
                      (a.sequence || 0) - (b.sequence || 0) ||
                      a.createdAt.localeCompare(b.createdAt),
                  )
                  .map((v) => ({
                    amount: v.amount,
                    effectiveDate: toBusinessDate(v.date),
                    notes: v.notes,
                    reason: v.reason,
                    createdAt: new Date(v.createdAt),
                    updatedAt: new Date(v.updatedAt),
                  })),
              },
            },
          });
          mapping.set(p.id, row.id);
          const originals = [...p.revisions].sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              (a.sequence || 0) - (b.sequence || 0) ||
              a.createdAt.localeCompare(b.createdAt),
          );
          const restored = await tx.revision.findMany({
            where: { positionId: row.id },
            orderBy: { sequence: 'asc' },
          });
          originals.forEach((v, i) => revisionMapping.set(v.id, restored[i].id));
        }
        for (const t of b.transfers || [])
          await tx.transfer.create({
            data: {
              userId: r.userId,
              importedFromId: t.importedFromId || t.id,
              sourceId: mapping.get(t.sourceId)!,
              targetId: mapping.get(t.targetId)!,
              sourceRevisionId: revisionMapping.get(t.sourceRevisionId)!,
              targetRevisionId: revisionMapping.get(t.targetRevisionId)!,
              sourceCurrency: t.sourceCurrency,
              targetCurrency: t.targetCurrency,
              amount: t.amount,
              received: t.received,
              fee: t.fee,
              operation: t.operation,
              effectiveDate: toBusinessDate(t.date),
              notes: t.notes,
              createdAt: new Date(t.createdAt),
            },
          });
        for (const plan of b.schedules || []) {
          const { id, importedFromId, ...v } = plan;
          await tx.schedule.create({
            data: {
              ...v,
              userId: r.userId,
              importedFromId: importedFromId || id,
              sourceId: mapping.get(plan.sourceId)!,
              targetId: plan.targetId ? mapping.get(plan.targetId)! : null,
              nextAt: new Date(plan.nextAt + ':00+08:00'),
            },
          });
        }
        for (const l of b.links)
          await tx.positionLink.create({
            data: { sourceId: mapping.get(l.sourceId)!, targetId: mapping.get(l.targetId)! },
          });
        for (const v of b.rates) {
          const key = {
            userId: r.userId,
            currency: v.currency,
            baseCurrency: v.baseCurrency,
            date: new Date(v.date),
          };
          await tx.exchangeRate.upsert({
            where: { userId_currency_baseCurrency_date: key },
            create: { ...key, rate: v.rate, source: v.source },
            update: {},
          });
        }
        if (!ps.length && !rs.length)
          await tx.user.update({
            where: { id: r.userId },
            data: {
              baseCurrency: b.baseCurrency,
              idleMinutes: b.preferences?.idleMinutes,
              hiddenMenus: b.preferences?.hiddenMenus?.join(','),
              showNotes: b.preferences?.showNotes,
            },
          });
        return { ok: true, positions: b.positions.length };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 300000 },
    );
  }
}
