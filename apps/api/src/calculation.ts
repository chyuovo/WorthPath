import Decimal from 'decimal.js';
Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
export type Holding = {
  id: string;
  name: string;
  kind: string;
  side: string;
  currency: string;
  revisions: {
    id: string;
    sequence?: number;
    createdAt?: Date;
    amount: { toString(): string };
    effectiveDate: Date;
    notes: string;
    reason: string;
  }[];
};
export type Rate = {
  currency: string;
  baseCurrency: string;
  date: Date;
  rate: { toString(): string };
  source: string;
};
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const businessTime = (d: Date) => new Date(+d + 8 * 3600000).toISOString().slice(0, 16);
export const businessDay = (d: Date) => businessTime(d).slice(0, 10);
export function compareRevisions(a: Holding['revisions'][number], b: Holding['revisions'][number]) {
  return +a.effectiveDate - +b.effectiveDate || (a.sequence || 0) - (b.sequence || 0);
}
export function history(p: Holding) {
  let before = new Decimal(0);
  return [...p.revisions].sort(compareRevisions).map((r) => {
    const after = new Decimal(r.amount.toString());
    const row = {
      id: r.id,
      sequence: r.sequence || 0,
      createdAt: r.createdAt?.toISOString() || null,
      positionId: p.id,
      name: p.name,
      kind: p.kind,
      currency: p.currency,
      date: businessDay(r.effectiveDate),
      time: businessTime(r.effectiveDate),
      before: before.toFixed(),
      after: after.toFixed(),
      delta: after.minus(before).toFixed(),
      notes: r.notes,
      reason: r.reason,
    };
    before = after;
    return row;
  });
}
export function rateAt(rates: Rate[], currency: string, base: string, date: string) {
  if (currency === base) return { value: new Decimal(1), date, source: 'identity' };
  const r = rates
    .filter((r) => r.currency === currency && r.baseCurrency === base && day(r.date) <= date)
    .sort((a, b) => +b.date - +a.date)[0];
  return r ? { value: new Decimal(r.rate.toString()), date: day(r.date), source: r.source } : null;
}
export function totals(positions: Holding[], rates: Rate[], base: string, date: string) {
  let assets = new Decimal(0),
    liabilities = new Decimal(0);
  const missing = new Set<string>();
  const items = positions.map((p) => {
    const rev = p.revisions
        .filter((r) => businessDay(r.effectiveDate) <= date)
        .sort((a, b) => compareRevisions(b, a))[0],
      amount = new Decimal(rev?.amount.toString() || '0'),
      fx = rateAt(rates, p.currency, base, date);
    if (!fx && !amount.isZero()) missing.add(p.currency);
    const converted = fx ? amount.mul(fx.value) : null;
    if (converted) {
      if (p.side === 'asset') assets = assets.plus(converted);
      else liabilities = liabilities.plus(converted);
    }
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      side: p.side,
      currency: p.currency,
      amount: amount.toFixed(),
      converted: converted?.toFixed(2) ?? null,
      rateDate: fx?.date ?? null,
      source: fx?.source ?? null,
    };
  });
  return {
    date,
    assets: assets.toFixed(2),
    liabilities: liabilities.toFixed(2),
    net: assets.minus(liabilities).toFixed(2),
    complete: missing.size === 0,
    missing: [...missing],
    items,
  };
}
export function overview(positions: Holding[], rates: Rate[], base: string, date: string) {
  const dates = [
    ...new Set([
      ...positions.flatMap((p) => p.revisions.map((r) => businessDay(r.effectiveDate))),
      ...rates.filter((r) => r.baseCurrency === base).map((r) => day(r.date)),
      date,
    ]),
  ]
    .filter((d) => d <= date)
    .sort();
  let previous: ReturnType<typeof totals> | undefined;
  const trend = dates.map((d) => {
    const value = totals(positions, rates, base, d);
    let balanceChange: string | null = null,
      fxChange: string | null = null;
    if (previous?.complete && value.complete) {
      let revalued = new Decimal(0);
      for (const item of previous.items) {
        const fx = rateAt(rates, item.currency, base, d);
        if (!fx && !new Decimal(item.amount).isZero()) {
          revalued = new Decimal(NaN);
          break;
        }
        const v = new Decimal(item.amount).mul(fx?.value || 0);
        revalued = revalued.plus(item.side === 'asset' ? v : v.neg());
      }
      if (revalued.isFinite()) {
        fxChange = revalued.minus(previous.net).toFixed(2);
        balanceChange = new Decimal(value.net).minus(revalued).toFixed(2);
      }
    }
    previous = value;
    return { ...value, balanceChange, fxChange };
  });
  return {
    baseCurrency: base,
    ...totals(positions, rates, base, date),
    trend,
    recent: positions
      .flatMap(history)
      .sort((a, b) => b.time.localeCompare(a.time) || b.sequence - a.sequence)
      .slice(0, 20),
  };
}
