import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Req,
  Param,
  Query,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Database } from './database';
import { UserRequest } from './auth';
import {
  positionInput,
  positionMeta,
  revisionInput,
  today,
  toBusinessDate,
  pairedReasons,
} from './validation';
import { totals, trend } from './calculation';
import { currentPositions, currentRates, historyPage, trendData, trendInput } from './queries';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { IconsService } from './icons';
import { MetalsService } from './metals';
import { RatesService } from './rates';
import { captureReplay } from './replay';
import { changeMovement } from './transfers';
@Controller('api')
export class PortfolioController {
  constructor(
    private db: Database,
    private fx: RatesService,
    private icons: IconsService,
    private metals: MetalsService,
  ) {}
  private async own(userId: string, id: string, revealed = false) {
    const [p] = await this.db.$transaction((tx) => currentPositions(tx, userId, revealed, id));
    if (!p) throw new NotFoundException('项目不存在');
    return p;
  }
  @Get('positions') async list(@Req() r: UserRequest, @Query('kind') inputKind?: string) {
    const kind = z.enum(['account', 'asset', 'debt']).optional().parse(inputKind);
    return this.db.$transaction(async (tx) => {
      const rows = await currentPositions(tx, r.userId, r.revealed, undefined, kind);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: r.userId },
        select: { baseCurrency: true, includeIndependentAssets: true },
      });
      const rates = await currentRates(
        tx,
        r.userId,
        rows.map((p) => p.currency),
        user.baseCurrency,
        today(),
      );
      const amounts = new Map(
        totals(rows, rates, user.baseCurrency, today()).items.map((p) => [p.id, p]),
      );
      return rows.map(({ revisions, userId, ...p }) => ({
        ...p,
        amount: revisions[0]?.amount.toString() || '0',
        converted: amounts.get(p.id)!.converted,
        rateDate: amounts.get(p.id)!.rateDate,
      }));
    });
  }
  @Get('positions/:id') async detail(@Req() r: UserRequest, @Param('id') id: string) {
    const { revisions, userId, ...p } = await this.own(r.userId, id, r.revealed);
    return { ...p, amount: revisions[0]?.amount.toString() || '0' };
  }
  @Get('history') async history(@Req() r: UserRequest, @Query() query: unknown) {
    return this.db.$transaction((tx) => historyPage(tx, r.userId, r.revealed, query));
  }
  @Get('positions/:id/history') async positionHistory(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.db.$transaction(async (tx) => {
      const p = await tx.position.findFirst({
        where: { id, userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
      });
      if (!p) throw new NotFoundException('项目不存在');
      return historyPage(tx, r.userId, r.revealed, { ...query, positionId: id });
    });
  }
  @Get('trend') async trend(@Req() r: UserRequest, @Query() query: unknown) {
    const q = trendInput(query);
    return this.db.$transaction(
      async (tx) => {
        const data = await trendData(tx, r.userId, r.revealed, q.from, q.to);
        return {
          ...q,
          baseCurrency: data.base,
          revealed: r.revealed,
          items: trend(data.positions, data.rates, data.base, q.from, q.to, q.grain),
        };
      },
      { timeout: 30000 },
    );
  }
  @Post('positions') async create(@Req() r: UserRequest, @Body() b: unknown) {
    const v = positionInput.parse(b),
      { amount, date, ...meta } = v;
    await this.icons.requireVisible(r.userId, meta.iconId);
    const created = await this.db.position.create({
      data: {
        ...meta,
        userId: r.userId,
        revisions: {
          create: {
            amount,
            effectiveDate: toBusinessDate(date),
            notes: v.notes,
            reason: 'initial',
          },
        },
      },
      select: { id: true },
    });
    this.fx.invalidate(r.userId);
    return created;
  }
  @Patch('positions/:id') async edit(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const v = positionMeta.parse(b),
      p = await this.own(r.userId, id, r.revealed);
    if (
      p.kind === 'account' &&
      ['credit_card', 'loan'].includes(v.category) &&
      p.side !== 'liability'
    )
      throw new BadRequestException('信用卡和贷款账户必须为负债');
    await this.icons.requireVisible(r.userId, v.iconId);
    await this.db.position.update({
      where: { id: p.id },
      data: {
        ...v,
        ...(p.kind === 'asset' && v.category !== 'gold'
          ? { metalType: null, metalGrams: null, metalPurity: '1', autoValuation: false }
          : {}),
      },
    });
    return { ok: true };
  }
  @Post('positions/:id/revisions') async revise(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const v = revisionInput.parse(b);
    if (pairedReasons.includes(v.reason)) throw new BadRequestException('请使用账户转账接口');
    return this.db.serial(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM Position WHERE id = ${id} AND userId = ${r.userId} FOR UPDATE`,
      );
      const p = await tx.position.findFirst({
        where: { id, userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
      });
      if (!p) throw new NotFoundException('项目不存在');
      if (p.archived) throw new ConflictException('请先恢复归档项目');
      if (v.amount.startsWith('-') && p.kind !== 'account')
        throw new BadRequestException('仅账户支持负余额');
      const lastTransfer = await tx.revision.findFirst({
        where: { positionId: p.id, reason: { in: pairedReasons } },
        orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }],
      });
      if (lastTransfer && toBusinessDate(v.date) < lastTransfer.effectiveDate)
        throw new ConflictException('余额调整时间不能早于已有转账；请使用当前时间调整');
      if (v.reason === 'repayment') {
        if (p.side !== 'liability') throw new BadRequestException('还款记录只能用于负债');
        const prior = await tx.revision.findFirst({
          where: { positionId: p.id, effectiveDate: { lte: toBusinessDate(v.date) } },
          orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }],
        });
        if (!prior || new Prisma.Decimal(v.amount).gt(prior.amount))
          throw new BadRequestException('还款后的欠款不能高于该业务日期的原欠款');
      }
      return tx.revision.create({
        data: {
          positionId: p.id,
          amount: v.amount,
          effectiveDate: toBusinessDate(v.date),
          notes: v.notes,
          reason: v.reason,
        },
      });
    });
  }
  @Put('positions/:id/revisions/:revisionId') async correct(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() b: unknown,
  ) {
    const v = revisionInput.parse(b);
    return this.db.serial(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM Position WHERE id = ${id} AND userId = ${r.userId} FOR UPDATE`,
      );
      const p = await tx.position.findFirst({
        where: { id, userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
      });
      if (!p) throw new NotFoundException('项目不存在');
      if (p.archived) throw new ConflictException('请先恢复归档项目');
      if (v.amount.startsWith('-') && p.kind !== 'account')
        throw new BadRequestException('仅账户支持负余额');
      const original = await tx.revision.findFirst({ where: { id: revisionId, positionId: p.id } });
      if (!original) throw new NotFoundException('历史记录不存在');
      if (pairedReasons.includes(original.reason))
        throw new ConflictException('请在资金往来中修改完整配对记录');
      const replay = await captureReplay(tx, r.userId, [id]);
      await tx.revision.update({
        where: { id: revisionId },
        data: {
          amount: v.amount,
          effectiveDate: toBusinessDate(v.date),
          notes: v.notes,
          reason: 'correction',
        },
      });
      await replay();
      return { ok: true };
    });
  }

  @Delete('positions/:id/revisions/:revisionId') async deleteRevision(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
  ) {
    return this.db.serial(async (tx) => {
      const p = await tx.position.findFirst({
        where: { id, userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
      });
      if (!p) throw new NotFoundException('项目不存在');
      if (p.archived) throw new ConflictException('请先恢复归档项目');
      const row = await tx.revision.findFirst({ where: { id: revisionId, positionId: id } });
      if (!row) throw new NotFoundException('历史记录不存在');
      if (pairedReasons.includes(row.reason)) {
        const movement = await tx.transfer.findFirst({
          where: {
            userId: r.userId,
            OR: [{ sourceRevisionId: revisionId }, { targetRevisionId: revisionId }],
          },
        });
        if (!movement) throw new ConflictException('配对记录不完整，无法删除');
        return changeMovement(tx, r, movement.id);
      }
      const replay = await captureReplay(tx, r.userId, [id]);
      await tx.revision.delete({ where: { id: revisionId } });
      await replay();
      return { ok: true };
    });
  }

  @Put('positions/:id/links') async link(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const { targetIds } = z
      .object({ targetIds: z.array(z.string().uuid()).max(20) })
      .strict()
      .parse(b);
    if (new Set(targetIds).size !== targetIds.length || targetIds.includes(id))
      throw new BadRequestException('关联不能重复或指向自身');
    return this.db.serial(async (tx) => {
      const source = await tx.position.findFirst({
        where: { id, userId: r.userId, kind: 'debt', ...(r.revealed ? {} : { hidden: false }) },
      });
      if (!source) throw new NotFoundException('债务不存在');
      const count = await tx.position.count({
        where: { id: { in: targetIds }, userId: r.userId, kind: { in: ['account', 'asset'] } },
      });
      if (count !== targetIds.length) throw new BadRequestException('只能关联自己的账户或资产');
      await tx.positionLink.deleteMany({ where: { sourceId: id } });
      await tx.positionLink.createMany({
        data: targetIds.map((targetId) => ({ sourceId: id, targetId })),
      });
      return { ok: true };
    });
  }
  @Get('overview') async overview(@Req() r: UserRequest) {
    void this.fx.daily(r.userId);
    void this.metals.daily(r.userId);
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: r.userId },
        select: { baseCurrency: true, includeIndependentAssets: true },
      });
      const positions = await currentPositions(tx, r.userId, r.revealed);
      const rates = await currentRates(
        tx,
        r.userId,
        positions.map((p) => p.currency),
        user.baseCurrency,
        today(),
      );
      return {
        baseCurrency: user.baseCurrency,
        ...totals(
          positions.map((p) => ({
            ...p,
            included: p.included && (p.kind !== 'asset' || user.includeIndependentAssets),
          })),
          rates,
          user.baseCurrency,
          today(),
        ),
        revealed: r.revealed,
      };
    });
  }
}
