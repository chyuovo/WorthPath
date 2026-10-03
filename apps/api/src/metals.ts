import {
  Injectable,
  Controller,
  Get,
  Post,
  Put,
  Req,
  Body,
  Param,
  OnModuleInit,
  OnModuleDestroy,
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { Database } from './database';
import { UserRequest } from './auth';
import { amount, currency, date, rateValue, today, toBusinessDate } from './validation';
import { businessTime, businessDay } from './calculation';
export const metalType = z.enum(['gold', 'silver']);
export const metalConfig = z
  .object({
    metalType,
    metalGrams: amount.refine((v) => new Decimal(v).gt(0), '重量必须大于零'),
    metalPurity: z
      .string()
      .regex(/^(0|1)(\.\d{1,8})?$/)
      .refine((v) => new Decimal(v).gt(0) && new Decimal(v).lte(1), '纯度应大于 0 且不超过 1'),
    autoValuation: z.boolean(),
  })
  .strict();
export const metalPriceInput = z.object({ metalType, currency, price: rateValue, date }).strict();
export function metalValue(grams: string, purity: string, price: string) {
  const value = new Decimal(grams).mul(purity).mul(price);
  if (value.gte('10000000000000000')) throw new BadRequestException('估价超出支持范围');
  return value.toFixed(8);
}
// Fixed public currencies; holdings, identifiers and quantities never leave the server.
const PUBLIC_PRICES = [
  'https://api.gold-api.com/price/XAU',
  'https://api.gold-api.com/price/XAG',
  'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,HKD,EUR,GBP,JPY,AUD,CAD,CHF,SGD',
];
@Injectable()
export class MetalsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private attempts = new Map<string, string>();
  private running = new Set<string>();
  private outcomes = new Map<string, { state: string; message: string; attemptedAt: string }>();
  constructor(private db: Database) {}
  invalidate(userId: string) {
    this.attempts.delete(userId);
  }
  status(userId: string) {
    return (
      this.outcomes.get(userId) || { state: 'idle', message: '尚未尝试更新', attemptedAt: null }
    );
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 3600000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async tick() {
    try {
      for (const u of await this.db.user.findMany({ select: { id: true } })) await this.daily(u.id);
    } catch {
      /* Preserve previous quotes. */
    }
  }
  async daily(userId: string) {
    if (this.attempts.get(userId) === today() || this.running.has(userId)) return;
    this.attempts.set(userId, today());
    try {
      await this.refresh(userId);
    } catch {
      /* Status explains failure. */
    }
  }
  async apply(
    tx: Prisma.TransactionClient,
    userId: string,
    id: string,
    revealed: boolean,
    force = false,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM Position WHERE id=${id} AND userId=${userId} FOR UPDATE`,
    );
    const p = await tx.position.findFirst({
      where: {
        id,
        userId,
        kind: 'asset',
        category: 'gold',
        archived: false,
        ...(revealed ? {} : { hidden: false }),
      },
      include: {
        revisions: { orderBy: [{ effectiveDate: 'desc' }, { sequence: 'desc' }], take: 1 },
      },
    });
    if (!p) throw new NotFoundException('贵金属资产不存在或已归档');
    if (!p.metalType || !p.metalGrams)
      throw new BadRequestException('请先设置贵金属品种、重量和纯度');
    const quote = await tx.metalPrice.findFirst({
      where: {
        userId,
        metalType: p.metalType,
        currency: p.currency,
        date: { lte: new Date(today()) },
      },
      orderBy: { date: 'desc' },
    });
    if (!quote) throw new BadRequestException('缺少该币种的贵金属价格，请刷新或手动录价');
    const value = metalValue(
      p.metalGrams.toString(),
      p.metalPurity.toString(),
      quote.price.toString(),
    );
    const last = p.revisions[0];
    // Old market quotes cannot overwrite a newer observation automatically.
    if (last && new Decimal(last.amount.toString()).eq(value))
      return { amount: value, changed: false };
    if (!force && last && businessDay(last.effectiveDate) > businessDay(quote.date))
      return { amount: value, changed: false };
    const now = toBusinessDate(businessTime(new Date()));
    if (last && last.effectiveDate > now) throw new BadRequestException('估价时间不能早于最新余额');
    await tx.revision.create({
      data: {
        positionId: id,
        amount: value,
        effectiveDate: now,
        reason: 'valuation',
        notes: `贵金属估价：${p.metalGrams} 克 × 纯度 ${p.metalPurity} × ${quote.price} ${p.currency}/克；报价 ${quote.date.toISOString().slice(0, 10)}（${quote.source}）`,
      },
    });
    return { amount: value, changed: true };
  }
  async refresh(userId: string) {
    if (this.running.has(userId)) return { message: '贵金属价格更新正在进行' };
    this.running.add(userId);
    this.outcomes.set(userId, {
      state: 'updating',
      message: '正在更新贵金属参考价',
      attemptedAt: new Date().toISOString(),
    });
    try {
      const configured = await this.db.position.findMany({
        where: {
          userId,
          kind: 'asset',
          category: 'gold',
          archived: false,
          metalType: { not: null },
        },
        select: { id: true, currency: true, metalType: true },
      });
      if (!configured.length) {
        const message = '当前没有已设置重量的贵金属资产';
        this.outcomes.set(userId, { state: 'ok', message, attemptedAt: new Date().toISOString() });
        return { message };
      }
      const raw = await Promise.all(
        PUBLIC_PRICES.map(async (url) => {
          const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
          if (!response.ok) throw Error();
          return (await response.text()).replace(
            /("(?:price|rate)"\s*:\s*)(\d+(?:\.\d+)?)/g,
            '$1"$2"',
          );
        }),
      );
      const schema = z.object({
        currency: z.literal('USD'),
        symbol: z.enum(['XAU', 'XAG']),
        price: rateValue,
        updatedAt: z.iso.datetime(),
      });
      const gold = schema.parse(JSON.parse(raw[0])),
        silver = schema.parse(JSON.parse(raw[1]));
      if (gold.symbol !== 'XAU' || silver.symbol !== 'XAG') throw Error();
      for (const q of [gold, silver])
        if (
          +new Date(q.updatedAt) > Date.now() + 60000 ||
          +new Date(q.updatedAt) < Date.now() - 14 * 86400000
        )
          throw Error();
      const fx = z
        .array(z.object({ base: z.literal('USD'), quote: currency, date, rate: rateValue }))
        .parse(JSON.parse(raw[2]));
      await this.db.serial(async (tx) => {
        // Lock the owner to serialize with clear/import. Re-read positions after the network request.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${userId} FOR UPDATE`);
        const ps = await tx.position.findMany({
          where: {
            userId,
            kind: 'asset',
            category: 'gold',
            archived: false,
            metalType: { not: null },
          },
        });
        for (const p of ps) {
          const row = p.metalType === 'gold' ? gold : silver;
          const quoteDay = businessDay(new Date(row.updatedAt));
          const conversion = p.currency === 'USD' ? null : fx.find((v) => v.quote === p.currency);
          if (p.currency !== 'USD' && !conversion) throw Error();
          if (
            conversion &&
            (conversion.date > today() || +new Date(conversion.date) < Date.now() - 14 * 86400000)
          )
            throw Error();
          const price = rateValue.parse(
            new Decimal(row.price)
              .div('31.1034768')
              .mul(conversion?.rate || '1')
              .toFixed(12),
          );
          const key = {
            userId,
            metalType: p.metalType!,
            currency: p.currency,
            date: new Date(quoteDay),
          };
          const existing = await tx.metalPrice.findUnique({
            where: { userId_metalType_currency_date: key },
          });
          if (existing?.source !== 'manual')
            await tx.metalPrice.upsert({
              where: { userId_metalType_currency_date: key },
              create: { ...key, price, source: 'goldapi', quotedAt: new Date(row.updatedAt) },
              update: { price, source: 'goldapi', quotedAt: new Date(row.updatedAt) },
            });
          if (p.autoValuation) await this.apply(tx, userId, p.id, true);
        }
      });
      const message = '贵金属参考价已更新；同日手动价格已保留，已开启的自动估价已记入历史';
      this.attempts.set(userId, today());
      this.outcomes.set(userId, { state: 'ok', message, attemptedAt: new Date().toISOString() });
      return { message };
    } catch {
      this.outcomes.set(userId, {
        state: 'error',
        message: '贵金属价格更新失败，已有价格与估值已保留，可手动录价',
        attemptedAt: new Date().toISOString(),
      });
      throw new BadGatewayException('贵金属价格更新失败，已有价格与估值已保留，可手动录价');
    } finally {
      this.running.delete(userId);
    }
  }
}
@Controller('api/metals')
export class MetalsController {
  constructor(
    private db: Database,
    private metals: MetalsService,
  ) {}
  @Get() async list(@Req() r: UserRequest) {
    void this.metals.daily(r.userId);
    return {
      status: this.metals.status(r.userId),
      prices: await this.db.metalPrice.findMany({
        where: { userId: r.userId },
        orderBy: { date: 'desc' },
        take: 100,
      }),
    };
  }
  @Post('refresh') refresh(@Req() r: UserRequest) {
    return this.metals.refresh(r.userId);
  }
  @Post('prices') async manual(@Req() r: UserRequest, @Body() body: unknown) {
    const v = metalPriceInput.parse(body);
    const key = {
      userId: r.userId,
      metalType: v.metalType,
      currency: v.currency,
      date: new Date(v.date),
    };
    return this.db.serial(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM User WHERE id=${r.userId} FOR UPDATE`);
      await tx.metalPrice.upsert({
        where: { userId_metalType_currency_date: key },
        create: { ...key, price: v.price, source: 'manual', quotedAt: new Date() },
        update: { price: v.price, source: 'manual', quotedAt: new Date() },
      });
      const ps = await tx.position.findMany({
        where: {
          userId: r.userId,
          kind: 'asset',
          category: 'gold',
          metalType: v.metalType,
          currency: v.currency,
          archived: false,
          autoValuation: true,
          ...(r.revealed ? {} : { hidden: false }),
        },
      });
      for (const p of ps) await this.metals.apply(tx, r.userId, p.id, r.revealed);
      return { message: '贵金属价格已保存' };
    });
  }
  @Put(':id') async configure(
    @Req() r: UserRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const v = metalConfig.parse(body);
    const result = await this.db.serial(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM Position WHERE id=${id} AND userId=${r.userId} FOR UPDATE`,
      );
      const p = await tx.position.findFirst({
        where: {
          id,
          userId: r.userId,
          kind: 'asset',
          category: 'gold',
          archived: false,
          ...(r.revealed ? {} : { hidden: false }),
        },
      });
      if (!p) throw new NotFoundException('贵金属资产不存在或已归档');
      await tx.position.update({ where: { id }, data: v });
      if (
        v.autoValuation &&
        (await tx.metalPrice.count({
          where: {
            userId: r.userId,
            metalType: v.metalType,
            currency: p.currency,
            date: { lte: new Date(today()) },
          },
        }))
      )
        await this.metals.apply(tx, r.userId, id, r.revealed, true);
      return { message: '贵金属估价设置已保存' };
    });
    this.metals.invalidate(r.userId);
    return result;
  }
  @Post(':id/value') value(@Req() r: UserRequest, @Param('id') id: string) {
    return this.db.serial((tx) => this.metals.apply(tx, r.userId, id, r.revealed, true));
  }
}
