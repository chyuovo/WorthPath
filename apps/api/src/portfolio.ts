import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Body,
  Req,
  Param,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Database } from './database';
import { UserRequest } from './auth';
import { positionInput, positionMeta, revisionInput, today, toBusinessDate } from './validation';
import { history, overview } from './calculation';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { RatesService } from './rates';
@Controller('api')
export class PortfolioController {
  constructor(
    private db: Database,
    private fx: RatesService,
  ) {}
  private async own(userId: string, id: string, revealed = false) {
    const p = await this.db.position.findFirst({
      where: { id, userId, ...(revealed ? {} : { hidden: false }) },
      include: {
        revisions: { orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }] },
        outgoing: true,
      },
    });
    if (!p) throw new NotFoundException('项目不存在');
    return p;
  }
  @Get('positions') async list(@Req() r: UserRequest) {
    const rows = await this.db.position.findMany({
      where: { userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
      include: {
        revisions: { orderBy: [{ effectiveDate: 'asc' }, { sequence: 'asc' }] },
        outgoing: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({
      ...p,
      userId: undefined,
      amount: p.revisions.at(-1)?.amount.toString() || '0',
      history: history(p),
    }));
  }
  @Get('positions/:id') async detail(@Req() r: UserRequest, @Param('id') id: string) {
    const p = await this.own(r.userId, id, r.revealed);
    return { ...p, userId: undefined, history: history(p) };
  }
  @Post('positions') async create(@Req() r: UserRequest, @Body() b: unknown) {
    const v = positionInput.parse(b),
      { amount, date, ...meta } = v;
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
    await this.db.position.update({ where: { id: p.id }, data: v });
    return { ok: true };
  }
  @Post('positions/:id/revisions') async revise(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const v = revisionInput.parse(b);
    return this.db.$transaction(
      async (tx) => {
        const p = await tx.position.findFirst({
          where: { id, userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
        });
        if (!p) throw new NotFoundException('项目不存在');
        if (p.archived) throw new ConflictException('请先恢复归档项目');
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  @Put('positions/:id/revisions/:revisionId') async correct(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
    @Body() b: unknown,
  ) {
    const v = revisionInput.parse(b),
      p = await this.own(r.userId, id, r.revealed);
    if (p.archived) throw new ConflictException('请先恢复归档项目');
    if (!p.revisions.some((x) => x.id === revisionId))
      throw new NotFoundException('历史记录不存在');
    await this.db.revision.update({
      where: { id: revisionId },
      data: {
        amount: v.amount,
        effectiveDate: toBusinessDate(v.date),
        notes: v.notes,
        reason: 'correction',
      },
    });
    return { ok: true };
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
    return this.db.$transaction(
      async (tx) => {
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  @Get('overview') async overview(@Req() r: UserRequest) {
    void this.fx.daily(r.userId);
    const [user, positions, rates] = await this.db.$transaction([
      this.db.user.findUniqueOrThrow({
        where: { id: r.userId },
        select: { baseCurrency: true },
      }),
      this.db.position.findMany({
        where: { userId: r.userId, ...(r.revealed ? {} : { hidden: false }) },
        include: { revisions: true },
      }),
      this.db.exchangeRate.findMany({ where: { userId: r.userId } }),
    ]);
    return { ...overview(positions, rates, user.baseCurrency, today()), revealed: r.revealed };
  }
}
