export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({ message: '服务响应异常' }));
  if (!res.ok) throw new ApiError(body.message || '操作失败', res.status);
  return body;
}
export type User = {
  username: string;
  baseCurrency: string;
  hiddenMenus: string[];
  showNotes: boolean;
  idleMinutes: number;
  accountGroupOrder?: string[];
  revealed?: boolean;
  revealUntil?: string | null;
  lastActivity?: string;
};
export type History = {
  id: string;
  sequence: number;
  createdAt: string | null;
  time: string;
  positionId: string;
  name: string;
  kind: string;
  side: string;
  before: string;
  after: string;
  delta: string;
  currency: string;
  date: string;
  notes: string;
  reason: string;
};
export type Position = {
  groupName?: string;
  iconId?: string | null;
  id: string;
  kind: string;
  side: string;
  name: string;
  category: string;
  currency: string;
  amount: string;
  notes: string;
  archived: boolean;
  hidden: boolean;
  converted: string | null;
  rateDate: string | null;
  outgoing: { targetId: string; target: { name: string; kind: string } }[];
};
export type Total = {
  date: string;
  assets: string;
  liabilities: string;
  net: string;
  complete: boolean;
  missing: string[];
  balanceChange?: string | null;
  fxChange?: string | null;
};
export type Overview = Total & {
  baseCurrency: string;
  revealed: boolean;
  trend: Total[];
  recent: History[];
  items: {
    id: string;
    kind: string;
    converted: string | null;
    rateDate: string | null;
    currency: string;
    amount: string;
    source: string | null;
  }[];
};
export type Rate = {
  currency: string;
  baseCurrency: string;
  rate: string;
  date: string;
  source: string;
};
export const currencies = ['CNY', 'USD', 'HKD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'SGD'];
export function today() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export const nowMinute = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
export const displayTime = (s: string) => s.replace('T', ' ');
export function money(v: string, currency: string) {
  const [whole, frac] = v.split('.');
  const symbol =
    (
      { CNY: '¥', USD: 'US$', HKD: 'HK$', EUR: '€', GBP: '£', JPY: 'JP¥' } as Record<string, string>
    )[currency] || currency;
  return `${symbol} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac !== undefined ? '.' + frac : ''}`;
}

export type Transfer = {
  id: string;
  operation: string;
  sourceId: string;
  targetId: string;
  source: { name: string; kind: string };
  target: { name: string; kind: string };
  sourceCurrency: string;
  targetCurrency: string;
  amount: string;
  received: string;
  fee: string;
  date: string;
  notes: string;
};

// getRandomValues also works when a development tunnel uses plain HTTP.
export function requestUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type PageResult<T> = { items: T[]; nextCursor: string | null; revealed: boolean };

// Stored liability balances are amounts owed; negative account balances are credit.
export function positionAmount(
  p: Pick<Position, 'side'> & { amount?: string },
  value = p.amount || '0',
) {
  if (p.side !== 'liability' || /^-?0(?:\.0+)?$/.test(value))
    return value.replace(/^-0(?=\.0+$|$)/, '0');
  return value.startsWith('-') ? value.slice(1) : '-' + value;
}
export function accountInputAmount(p: Pick<Position, 'kind' | 'side'>, value: string) {
  return p.kind === 'account' ? positionAmount(p, value) : value;
}
