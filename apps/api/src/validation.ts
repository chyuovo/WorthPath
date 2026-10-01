import { z } from 'zod';
export const currencies = [
  'CNY',
  'USD',
  'HKD',
  'EUR',
  'GBP',
  'JPY',
  'AUD',
  'CAD',
  'CHF',
  'SGD',
] as const;
export const currency = z.enum(currencies);
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + 'T00:00:00Z');
    return (
      Number.isFinite(+d) && d.toISOString().slice(0, 10) === s && s >= '1900-01-01' && s <= today()
    );
  }, '日期无效或在未来');
export const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/, '金额须为非负十进制字符串，最多 16 位整数和 8 位小数');
export const rateValue = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/)
  .refine((s) => /[1-9]/.test(s), '汇率必须大于零');
export const notes = z.string().max(2000).default('');
export const revisionInput = z
  .object({
    amount,
    date,
    notes,
    reason: z
      .enum(['initial', 'balance', 'valuation', 'repayment', 'correction'])
      .default('balance'),
  })
  .strict();
export const positionMeta = z
  .object({
    name: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(40),
    notes,
    archived: z.boolean().default(false),
  })
  .strict();
export const positionInput = positionMeta
  .extend({
    kind: z.enum(['account', 'asset', 'debt']),
    side: z.enum(['asset', 'liability']),
    currency,
    amount,
    date,
  })
  .strict()
  .superRefine((p, c) => {
    if (
      (p.kind === 'asset' && p.side !== 'asset') ||
      (p.kind === 'debt' && p.side !== 'liability') ||
      (p.kind === 'account' &&
        ['credit_card', 'loan'].includes(p.category) &&
        p.side !== 'liability')
    )
      c.addIssue({ code: 'custom', message: '项目类型与资产负债属性不符' });
  });
export const rateInput = z
  .object({ currency, baseCurrency: currency, date, rate: rateValue })
  .strict()
  .refine((r) => r.currency !== r.baseCurrency, '同币种无需汇率');
export const credentials = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[\p{L}\p{N}_@.\-]+$/u),
    password: z
      .string()
      .min(10)
      .max(72)
      .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, '密码最多 72 字节'),
  })
  .strict();
