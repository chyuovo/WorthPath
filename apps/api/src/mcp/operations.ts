import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, AgentGrant } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { Database } from '../database';
import { UserRequest } from '../auth';
import { AgentOAuth, digest, webLink } from './oauth';
import { AgentCatalogue, ToolDefinition, empty } from './catalogue';
import { AgentFiles } from './files';
export const writing = {
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .describe('同用户唯一幂等键；重试使用相同键和全部参数，改动参数必须换键'),
  expectedState: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe('先 state_get 获取 state，避免覆盖并发修改；状态变化后重新读取并使用新幂等键'),
};
export const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
function stable(v: any): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
}
@Injectable()
export class AgentOperations {
  readonly tools: ToolDefinition[];
  constructor(
    private db: Database,
    private oauth: AgentOAuth,
    catalogue: AgentCatalogue,
    private files: AgentFiles,
  ) {
    this.tools = [
      ...catalogue.tools,
      {
        name: 'icon_publish',
        description: '保存已上传私有图标，不允许发布共享图标。先 file_upload_request(kind=icon)。',
        schema: z
          .object({
            fileId: z.string().uuid(),
            name: z.string().min(1).max(100),
            shared: z.literal(false).default(false),
          })
          .strict(),
        scope: 'write',
        run: (r, p) => this.files.publishIcon(r, r.agentGrantId!, p.fileId, p.name, p.shared),
      },
    ];
  }
  get(name: string) {
    const t = this.tools.find((t) => t.name === name);
    if (!t) throw new BadRequestException('未知工具');
    return t;
  }
  async context(grant: AgentGrant, writing = false) {
    let s = await this.db.session.findUnique({ where: { id: grant.sessionId } });
    // A permanent PAT is the credential. Its internal business session has a bounded
    // lifetime and may be recreated after the normal expired-session cleanup.
    if (!grant.expiresAt && !grant.clientId && (!s || s.expiresAt <= new Date())) {
      await this.oauth.grant(grant.id, grant.userId);
      s = await this.db.session.upsert({
        where: { id: grant.sessionId },
        create: {
          id: grant.sessionId,
          userId: grant.userId,
          expiresAt: new Date(Date.now() + 86400000),
        },
        update: {
          expiresAt: new Date(Date.now() + 86400000),
          revealUntil: null,
          backupDigest: null,
          backupExpiresAt: null,
        },
      });
    }
    if (!s || s.expiresAt <= new Date()) throw new ForbiddenException('连接会话失效，请重新授权');
    return {
      userId: grant.userId,
      sessionId: grant.sessionId,
      revealed: (grant.scopes as string[]).includes(writing ? 'hidden_write' : 'hidden_read'),
      agent: true,
      agentGrantId: grant.id,
      cookies: {},
    } as UserRequest;
  }
  async state(userId: string) {
    const data = await Promise.all([
      this.db.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          username: true,
          baseCurrency: true,
          hiddenMenus: true,
          showNotes: true,
          idleMinutes: true,
          accountGroupOrder: true,
          sessionHours: true,
          requireHiddenPassword: true,
          overviewCards: true,
          includeIndependentAssets: true,
        },
      }),
      this.db.position.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
        include: { revisions: { orderBy: { id: 'asc' } }, outgoing: { orderBy: { id: 'asc' } } },
      }),
      this.db.transfer.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.schedule.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.exchangeRate.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.metalPrice.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
      this.db.icon.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true, hash: true, shared: true },
        orderBy: { id: 'asc' },
      }),
    ]);
    return digest(stable(plain(data)));
  }
  private async permission(grant: AgentGrant, t: ToolDefinition, p: any) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: grant.userId } });
    if (user.banned || user.mustChangePassword) throw new ForbiddenException('账号不可用');
    if (user.role === 'readonly' && t.scope !== 'read')
      throw new ForbiddenException('只读账号不能提交写入或草稿');
    const selected = grant.scopes as string[];
    if (!selected.includes('read')) throw new ForbiddenException('缺少 read 权限');
    const mode = selected.includes('write')
      ? 'direct'
      : selected.includes('draft')
        ? 'draft'
        : 'readonly';
    if (t.scope === 'read') return { mode };
    if (mode === 'readonly') throw new ForbiddenException('本连接只有只读权限');
    if (!selected.includes('hidden_write') && (p.hidden === true || p.data?.hidden === true))
      throw new ForbiddenException('缺少隐藏账户修改权限');
    return { mode };
  }
  async call(grantId: string, name: string, input: any) {
    const t = this.get(name);
    const parsed = (t.scope === 'read' ? t.schema : t.schema.safeExtend(writing)).parse(input);
    const { idempotencyKey, expectedState, ...p } = parsed as any;
    const grant = await this.oauth.grant(grantId);
    await this.permission(grant, t, p);
    if (t.scope === 'read') return t.run!(await this.context(grant), p);
    const hash = digest(stable({ tool: name, parameters: p, expectedState }));
    return this.db.atomic(async () => {
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${grant.userId} FOR UPDATE`);
      const fresh = await this.oauth.grant(grantId),
        access = await this.permission(fresh, t, p);
      const existing = await this.db.agentOperation.findUnique({
        where: { userId_key: { userId: grant.userId, key: idempotencyKey } },
      });
      if (existing) {
        if (existing.hash !== hash || existing.grantId !== grant.id)
          throw new ConflictException('幂等键已用于不同参数或连接');
        return this.view(existing);
      }
      const snapshot = await this.state(grant.userId);
      if (snapshot !== expectedState)
        throw new ConflictException('账目已变化，请重新读取 state_get 和数据后使用新幂等键');
      const row = await this.db.agentOperation.create({
        data: {
          userId: grant.userId,
          grantId,
          key: idempotencyKey,
          hash,
          tool: name,
          parameters: plain(p),
          snapshot,
          expiresAt: new Date(Date.now() + 600000),
        },
      });
      if (access.mode === 'draft' || !(fresh.scopes as string[]).includes('write'))
        return this.view(row);
      const result = await this.execute(t, fresh, p);
      return this.view(
        await this.db.agentOperation.update({
          where: { id: row.id },
          data: { status: 'completed', result: plain(result), completedAt: new Date() },
        }),
      );
    });
  }
  private async execute(t: ToolDefinition, grant: AgentGrant, p: any) {
    return t.run!(await this.context(grant, true), p);
  }
  private view(row: any) {
    return {
      operationId: row.id,
      tool: row.tool,
      status: row.status === 'pending' && row.expiresAt < new Date() ? 'expired' : row.status,
      expiresAt: row.expiresAt,
      result: row.result,
      confirmationUrl: row.status === 'pending' ? webLink('agent_operation', row.id) : undefined,
    };
  }
  async status(grantId: string, id: string) {
    const grant = await this.oauth.grant(grantId),
      row = await this.db.agentOperation.findFirst({
        where: { id, userId: grant.userId, grantId },
      });
    if (!row) throw new NotFoundException('操作不存在');
    return this.view(row);
  }
  async preview(userId: string, id: string) {
    const row = await this.db.agentOperation.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('操作不存在');
    const t = this.get(row.tool),
      grant = await this.oauth.grant(row.grantId, userId);
    const selected = grant.scopes as string[];
    const ids = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) ids.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(row.parameters);
    const visible = { userId, ...(selected.includes('hidden_read') ? {} : { hidden: false }) };
    const positions = await this.db.position.findMany({
      where: { ...visible, id: { in: [...ids] } },
      select: { id: true, name: true, currency: true, side: true, kind: true },
    });
    const schedules = await this.db.schedule.findMany({
      where: { userId, id: { in: [...ids] } },
      select: { id: true, name: true, sourceId: true, targetId: true },
    });
    const visibleScheduleIds = new Set(
      (
        await this.db.position.findMany({
          where: {
            ...visible,
            id: { in: schedules.flatMap((s) => [s.sourceId, ...(s.targetId ? [s.targetId] : [])]) },
          },
          select: { id: true },
        })
      ).map((p) => p.id),
    );
    const references = Object.fromEntries([
      ...positions.map((p) => [p.id, p]),
      ...schedules
        .filter(
          (s) =>
            visibleScheduleIds.has(s.sourceId) &&
            (!s.targetId || visibleScheduleIds.has(s.targetId)),
        )
        .map((s) => [s.id, { name: s.name, kind: 'schedule' }]),
    ]);
    const p = row.parameters as Record<string, any>;
    let current: Record<string, unknown> | undefined;
    if (['movement_update', 'movement_delete'].includes(row.tool)) {
      const movement = await this.db.transfer.findFirst({
        where: { id: p.id, userId, source: visible, target: visible },
        include: { source: true, target: true },
      });
      if (movement) {
        references[movement.sourceId] = {
          name: movement.source.name,
          currency: movement.source.currency,
        };
        references[movement.targetId] = {
          name: movement.target.name,
          currency: movement.target.currency,
        };
        current = {
          operation: movement.operation,
          sourceId: movement.sourceId,
          targetId: movement.targetId,
          amount: movement.amount.toString(),
          received: movement.received.toString(),
          fee: movement.fee.toString(),
          date: new Date(+movement.effectiveDate + 8 * 3600000).toISOString().slice(0, 16),
          notes: movement.notes,
        };
      }
    } else if (['history_update', 'history_delete', 'balance_record'].includes(row.tool)) {
      const revision = await this.db.revision.findFirst({
        where: {
          positionId: p.id,
          position: visible,
          ...(p.revisionId ? { id: p.revisionId } : {}),
        },
        orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }],
      });
      if (revision)
        current = {
          id: p.id,
          amount: revision.amount.toString(),
          date: new Date(+revision.effectiveDate + 8 * 3600000).toISOString().slice(0, 16),
          notes: revision.notes,
        };
    }
    const impact = { parameters: row.parameters, references, current };
    return {
      ...this.view(row),
      impact,
      connectionName: grant.name,
      destructive: !!t.destructive,
      description: t.description,
    };
  }
  async confirm(r: UserRequest, id: string, raw: unknown, res: Response) {
    const input = z
      .object({
        approve: z.boolean(),
      })
      .strict()
      .parse(raw);
    return this.db.atomic(async () => {
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${r.userId} FOR UPDATE`);
      const row = await this.db.agentOperation.findFirst({ where: { id, userId: r.userId } });
      if (!row) throw new NotFoundException('操作不存在');
      if (row.status !== 'pending' || row.expiresAt <= new Date())
        throw new ConflictException('操作已完成或失效');
      if (!input.approve)
        return this.view(
          await this.db.agentOperation.update({
            where: { id },
            data: { status: 'cancelled', completedAt: new Date() },
          }),
        );
      const grant = await this.oauth.grant(row.grantId, r.userId),
        t = this.get(row.tool),
        p = row.parameters as any;
      await this.permission(grant, t, p);
      if ((await this.state(r.userId)) !== row.snapshot)
        throw new ConflictException('账目已变化，请取消并重新创建操作');
      const result = await this.execute(t, grant, p);
      if (row.tool === 'position_create') {
        // Advance only sibling additions reviewed against the same snapshot.
        // The user lock and transaction keep edits and other grants stale.
        await this.db.agentOperation.updateMany({
          where: {
            userId: r.userId,
            grantId: row.grantId,
            tool: 'position_create',
            status: 'pending',
            snapshot: row.snapshot,
            id: { not: row.id },
            expiresAt: { gt: new Date() },
          },
          data: { snapshot: await this.state(r.userId) },
        });
      }
      return this.view(
        await this.db.agentOperation.update({
          where: { id },
          data: { status: 'completed', result: plain(result), completedAt: new Date() },
        }),
      );
    }, 300000);
  }

  async drafts(userId: string, cursor?: string) {
    const rows = await this.db.agentOperation.findMany({
      where: { userId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 51,
    });
    const page = rows.slice(0, 50);
    const items = await Promise.all(
      page.map(async (row) => {
        try {
          return await this.preview(userId, row.id);
        } catch {
          return {
            operationId: row.id,
            tool: row.tool,
            status: 'unavailable',
            expiresAt: row.expiresAt,
            error: '连接已失效，请取消或重新授权后刷新',
          };
        }
      }),
    );
    return { items, nextCursor: rows.length > 50 ? page[49].id : null };
  }
  async confirmBatch(r: UserRequest, raw: unknown, res: Response) {
    const input = z
      .object({
        operationIds: z
          .array(z.string().uuid())
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, '草稿编号不能重复'),
        approve: z.boolean(),
      })
      .strict()
      .parse(raw);
    return this.db.atomic(async () => {
      await this.db.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${r.userId} FOR UPDATE`);
      const rows = await this.db.agentOperation.findMany({
        where: { userId: r.userId, id: { in: input.operationIds } },
      });
      if (rows.length !== input.operationIds.length) throw new NotFoundException('操作不存在');
      // A lost success response may be retried without executing anything twice.
      if (input.approve && rows.every((row) => row.status === 'completed'))
        return {
          operations: input.operationIds.map((id) => this.view(rows.find((row) => row.id === id)!)),
        };
      if (!input.approve) {
        if (rows.some((row) => row.status !== 'pending' || row.expiresAt <= new Date()))
          throw new ConflictException('部分草稿已完成或失效，请刷新后重新选择');
        await this.db.agentOperation.updateMany({
          where: { userId: r.userId, id: { in: input.operationIds } },
          data: { status: 'cancelled', completedAt: new Date() },
        });
        return { operations: rows.map((row) => this.view({ ...row, status: 'cancelled' })) };
      }
      const snapshot = await this.state(r.userId);
      for (const row of rows) {
        if (row.status !== 'pending' || row.expiresAt <= new Date())
          throw new ConflictException('部分草稿已完成或失效，请刷新后重新选择');
        if (row.snapshot !== snapshot)
          throw new ConflictException('账目已变化，请取消并重新创建操作');
        const grant = await this.oauth.grant(row.grantId, r.userId);
        await this.permission(grant, this.get(row.tool), row.parameters);
      }
      const operations = [];
      for (const id of input.operationIds) {
        // All selected drafts were reviewed against the same baseline above.
        // Only this atomic, manually confirmed batch may advance their snapshots.
        await this.db.agentOperation.update({
          where: { id },
          data: { snapshot: await this.state(r.userId) },
        });
        operations.push(await this.confirm(r, id, { approve: true }, res));
      }
      return { operations };
    }, 300000);
  }
  async uploadRequest(grantId: string, kind: 'icon') {
    const grant = await this.oauth.grant(grantId);
    const selected = grant.scopes as string[];
    if (!selected.includes('draft') && !selected.includes('write'))
      throw new ForbiddenException('上传需要 draft 或 write 权限');
    return this.files.issue(await this.context(grant), grantId, kind);
  }
  async fileStatus(grantId: string, id: string) {
    const g = await this.oauth.grant(grantId);
    return this.files.inspect(await this.context(g), grantId, id);
  }
  async iconImage(grantId: string, id: string) {
    const g = await this.oauth.grant(grantId);
    return this.files.issue(await this.context(g), grantId, 'image', id);
  }
}
