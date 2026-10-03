import { z } from 'zod';
import Decimal from 'decimal.js';
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
export const businessDate = z.string().refine((s) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return date.safeParse(s).success;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return false;
  const d = new Date(s + ':00+08:00');
  return (
    Number.isFinite(+d) &&
    new Date(+d + 8 * 3600000).toISOString().slice(0, 16) === s &&
    s >= '1900-01-01' &&
    +d <= Date.now()
  );
}, '业务时间无效或在未来（北京时间）');
export const toBusinessDate = (s: string) =>
  new Date((s.length === 10 ? s + 'T00:00' : s) + ':00+08:00');
export const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/, '金额须为非负十进制字符串，最多 16 位整数和 8 位小数');
export const rateValue = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,12})?$/)
  .refine((s) => /[1-9]/.test(s), '汇率必须大于零');
export const notes = z.string().max(2000).default('');
export const signedAmount = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,15})(\.\d{1,8})?$/, '金额最多 16 位整数和 8 位小数');
export const revisionInput = z
  .object({
    amount: signedAmount,
    date: businessDate,
    notes,
    reason: z
      .enum([
        'initial',
        'scheduled_expense',
        'balance',
        'valuation',
        'repayment',
        'correction',
        'transfer_out',
        'transfer_in',
        'loan_borrow',
        'loan_lend',
        'loan_collect',
        'loan_repay',
      ])
      .default('balance'),
  })
  .strict();
export const positionMeta = z
  .object({
    groupName: z.string().trim().max(60).optional(),
    iconId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(100),
    category: z.string().trim().min(1).max(40),
    notes,
    archived: z.boolean().default(false),
    hidden: z.boolean().default(false),
  })
  .strict();
export const positionInput = positionMeta
  .extend({
    kind: z.enum(['account', 'asset', 'debt']),
    side: z.enum(['asset', 'liability']),
    currency,
    amount: signedAmount,
    date: businessDate,
  })
  .strict()
  .superRefine((p, c) => {
    if (p.amount.startsWith('-') && p.kind !== 'account')
      c.addIssue({ code: 'custom', message: '仅账户支持负余额' });
    if (
      (p.kind === 'asset' && p.side !== 'asset') ||
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

export const menuKey = z.enum([
  'overview',
  'account',
  'asset',
  'debt',
  'history',
  'calendar',
  'schedules',
]);
export const hiddenMenus = z
  .array(menuKey)
  .max(7)
  .refine((v) => new Set(v).size === v.length, '菜单不可重复');
export const transferInput = z
  .object({
    operation: z.enum(['transfer', 'borrow', 'lend', 'collect', 'repay']).default('transfer'),
    requestId: z.string().uuid().optional(),
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
    amount: amount.refine((v) => /[1-9]/.test(v), '转出金额必须大于零'),
    received: amount.refine((v) => /[1-9]/.test(v), '到账金额必须大于零'),
    fee: z
      .string()
      .regex(
        /^-?(0|[1-9]\d{0,15})(\.\d{1,8})?$/,
        '手续费可为负数表示优惠，最多 16 位整数和 8 位小数',
      )
      .default('0'),
    date: businessDate,
    notes,
  })
  .strict()
  .refine((v) => v.sourceId !== v.targetId, '不能向同一账户转账')
  .refine((v) => new Decimal(v.fee).neg().lte(v.amount), {
    message: '手续费优惠不能超过转出金额',
    path: ['fee'],
  });
export const pairedReasons = [
  'transfer_out',
  'transfer_in',
  'loan_borrow',
  'loan_lend',
  'loan_collect',
  'loan_repay',
];

export const credentialChange = z
  .object({
    currentPassword: credentials.shape.password,
    username: credentials.shape.username.optional(),
    newPassword: credentials.shape.password.optional(),
  })
  .strict()
  .refine((v) => !!v.username || !!v.newPassword, '请填写新的账号或密码');
