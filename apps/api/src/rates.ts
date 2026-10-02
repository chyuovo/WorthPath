import {
  Injectable,
  Controller,
  Get,
  Patch,
  Post,
  Req,
  Body,
  Query,
  OnModuleInit,
  OnModuleDestroy,
  BadGatewayException,
} from '@nestjs/common';
import { Database } from './database';
import { UserRequest } from './auth';
import { currency, date, rateValue, today, hiddenMenus } from './validation';
import { z } from 'zod';
import Decimal from 'decimal.js';
// Fixed public request; no user currency choices, identifiers or amounts leave the server.
const PUBLIC_RATES =
  'https://api.frankfurter.dev/v2/rates?base=USD&quotes=CNY,HKD,EUR,GBP,JPY,AUD,CAD,CHF,SGD';
@Injectable()
export class RatesService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private attempts = new Map<string, string>();
  private running = new Set<string>();
  private outcomes = new Map<string, { state: string; attemptedAt: string; message: string }>();
  status(userId: string) {
    return (
      this.outcomes.get(userId) || { state: 'idle', attemptedAt: null, message: '尚未尝试更新' }
    );
  }
  invalidate(userId: string) {
    this.attempts.delete(userId);
  }
  constructor(private db: Database) {}
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
      /* Keep previous rates. */
    }
  }
  async daily(userId: string) {
    if (this.attempts.get(userId) === today() || this.running.has(userId)) return;
    this.attempts.set(userId, today());
    try {
      await this.refresh(userId);
    } catch {
      /* UI shows missing/stale rates. */
    }
  }
  async refresh(userId: string) {
    if (this.running.has(userId)) return { message: '汇率更新正在进行' };
    this.running.add(userId);
    this.outcomes.set(userId, {
      state: 'updating',
      attemptedAt: new Date().toISOString(),
      message: '正在更新公共日汇率',
    });
    try {
      const u = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
      const ps = await this.db.position.findMany({
        where: { userId },
        select: { currency: true },
        distinct: ['currency'],
      });
      if (!ps.some((p) => p.currency !== u.baseCurrency)) {
        const message = '当前没有需要换算的外币项目';
        this.outcomes.set(userId, { state: 'ok', attemptedAt: new Date().toISOString(), message });
        return { message };
      }
      const response = await fetch(PUBLIC_RATES, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error();
      const raw = (await response.text()).replace(
        /("rate"\s*:\s*)(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        '$1"$2"',
      );
      const rows = z
        .array(
          z.object({
            base: z.literal('USD'),
            quote: currency,
            date,
            rate: z.string().refine((s) => new Decimal(s).gt(0)),
          }),
        )
        .parse(JSON.parse(raw));
      const data = ps
        .filter((p) => p.currency !== u.baseCurrency)
        .map((p) => {
          const from = p.currency === 'USD' ? null : rows.find((v) => v.quote === p.currency),
            to = u.baseCurrency === 'USD' ? null : rows.find((v) => v.quote === u.baseCurrency);
          if ((p.currency !== 'USD' && !from) || (u.baseCurrency !== 'USD' && !to)) throw Error();
          if (from && to && from.date !== to.date) throw Error();
          const rate = rateValue.parse(
              new Decimal(to?.rate || '1').div(from?.rate || '1').toFixed(12),
            ),
            effectiveDate = from?.date || to!.date;
          return {
            userId,
            currency: p.currency,
            baseCurrency: u.baseCurrency,
            date: new Date(effectiveDate),
            rate,
            source: 'frankfurter',
          };
        });
      await this.db.$transaction(
        async (tx) => {
          // A clear or currency change during the network request must not recreate stale rates.
          const currentUser = await tx.user.findUniqueOrThrow({ where: { id: userId } });
          const currentPositions = await tx.position.findMany({
            where: { userId },
            select: { currency: true },
            distinct: ['currency'],
          });
          if (
            currentUser.baseCurrency !== u.baseCurrency ||
            JSON.stringify(currentPositions.map((p) => p.currency).sort()) !==
              JSON.stringify(ps.map((p) => p.currency).sort())
          )
            return;
          for (const v of data) {
            const { rate, source, ...key } = v;
            const existing = await tx.exchangeRate.findUnique({
              where: { userId_currency_baseCurrency_date: key },
            });
            if (existing?.source === 'manual') continue;
            await tx.exchangeRate.upsert({
              where: { userId_currency_baseCurrency_date: key },
              create: v,
              update: { rate, source },
            });
          }
        },
        { isolationLevel: 'Serializable' },
      );
      const message = '已保存最新可用日汇率；休市日可能沿用上一工作日。同日历史导入汇率已保留。';
      this.outcomes.set(userId, { state: 'ok', attemptedAt: new Date().toISOString(), message });
      return { message };
    } catch {
      this.outcomes.set(userId, {
        state: 'error',
        attemptedAt: new Date().toISOString(),
        message: '自动汇率更新失败，原币和已有汇率已保留，请稍后重试',
      });
      throw new BadGatewayException('汇率更新失败，原币金额和已有汇率已保留；可稍后重试或手动录入');
    } finally {
      this.running.delete(userId);
    }
  }
}
@Controller('api')
export class SettingsController {
  constructor(
    private db: Database,
    private fx: RatesService,
  ) {}
  @Get('settings') async settings(@Req() r: UserRequest, @Query('rates') includeRates?: string) {
    const showRates = z.enum(['true', 'false']).optional().parse(includeRates) === 'true';
    const u = await this.db.user.findUniqueOrThrow({
      where: { id: r.userId },
      select: {
        username: true,
        baseCurrency: true,
        hiddenMenus: true,
        showNotes: true,
        idleMinutes: true,
      },
    });
    return {
      ...u,
      hiddenMenus: u.hiddenMenus.split(',').filter(Boolean),
      lastActivity: (await this.db.session.findUniqueOrThrow({ where: { id: r.sessionId } }))
        .lastActivity,
      revealed: r.revealed,
      revealUntil: r.revealed
        ? (await this.db.session.findUniqueOrThrow({ where: { id: r.sessionId } })).revealUntil
        : null,
      fxStatus: this.fx.status(r.userId),
      rates: showRates
        ? await this.db.exchangeRate.findMany({
            where: { userId: r.userId },
            select: { currency: true, baseCurrency: true, date: true, rate: true, source: true },
            orderBy: [{ date: 'desc' }, { id: 'desc' }],
            take: 100,
          })
        : [],
    };
  }
  @Patch('settings') async update(@Req() r: UserRequest, @Body() b: unknown) {
    const data = z
      .object({
        baseCurrency: currency.optional(),
        hiddenMenus: hiddenMenus.optional(),
        showNotes: z.boolean().optional(),
        idleMinutes: z.number().int().min(0).max(1440).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0)
      .parse(b);
    await this.db.user.update({
      where: { id: r.userId },
      data: { ...data, hiddenMenus: data.hiddenMenus?.join(',') },
    });
    this.fx.invalidate(r.userId);
    return { ok: true };
  }
  @Post('rates/refresh') async refresh(@Req() r: UserRequest) {
    return this.fx.refresh(r.userId);
  }
}
