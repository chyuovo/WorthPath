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
export type User = { username: string; baseCurrency: string };
export type History = {
  id: string;
  sequence: number;
  createdAt: string | null;
  positionId: string;
  name: string;
  kind: string;
  before: string;
  after: string;
  delta: string;
  currency: string;
  date: string;
  notes: string;
  reason: string;
};
export type Position = {
  id: string;
  kind: string;
  side: string;
  name: string;
  category: string;
  currency: string;
  amount: string;
  notes: string;
  archived: boolean;
  history: History[];
  outgoing: { targetId: string }[];
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
  trend: Total[];
  recent: History[];
  items: {
    id: string;
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
export function money(v: string, currency: string) {
  const [whole, frac] = v.split('.');
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac !== undefined ? '.' + frac : ''}`;
}
