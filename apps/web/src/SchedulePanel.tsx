import { useEffect, useState } from 'react';
import { api, money, nowMinute, type Position } from './api';
import { AccountPicker } from './AccountPicker';
import { t as tr } from './i18n';
type Plan = {
  id: string;
  name: string;
  operation: string;
  amount: string;
  nextAt: string;
  intervalDays: number;
  enabled: boolean;
  completed: boolean;
  sourceId: string;
};
export function SchedulePanel({
  accounts,
  refresh,
}: {
  accounts: Position[];
  refresh: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Plan[]>([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const [operation, setOperation] = useState('expense'),
    [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [amount, setAmount] = useState('');
  const sourceId = accounts.some((p) => p.id === source) ? source : accounts[0]?.id || '';
  const sourceAccount = accounts.find((p) => p.id === sourceId),
    targetAccount = accounts.find((p) => p.id === target);
  const same = sourceAccount?.currency === targetAccount?.currency;
  useEffect(() => {
    let active = true;
    void api<Plan[]>('/schedules')
      .then((v) => {
        if (active) setRows(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [accounts]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
      await refresh();
      setRows(await api<Plan[]>('/schedules'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="schedule-panel">
      <summary>
        {tr('定时计划')} ({rows.length})
      </summary>
      <p className="muted">
        {tr('打开账户页时处理到期计划。每次最多执行20项，离线期间的计划会逐次补记。')}
      </p>
      <div className="actions">
        <button type="button" disabled={busy || !accounts.length} onClick={() => setOpen(!open)}>
          {tr(open ? '取消' : '添加计划')}
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await api<{
                executed: number;
                errors: { message: string }[];
                hasMore: boolean;
              }>('/schedules/run', 'POST', {});
              setStatus(
                tr('已执行') +
                  ` ${result.executed}` +
                  (result.hasMore ? ' · ' + tr('仍有到期计划，请再次执行') : ''),
              );
              if (result.errors.length) setError(result.errors[0].message);
            })
          }
        >
          {tr('执行到期计划')}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = Object.fromEntries(new FormData(e.currentTarget));
            void act(async () => {
              await api('/schedules', 'POST', {
                ...data,
                operation,
                sourceId,
                targetId: operation === 'transfer' ? target : null,
                received: operation === 'transfer' ? (same ? amount : data.received) : '0',
                intervalDays: Number(data.intervalDays),
              });
              setOpen(false);
            });
          }}
        >
          <label>
            {tr('计划名称')}
            <input name="name" required maxLength={100} />
          </label>
          <label>
            {tr('操作')}
            <select value={operation} onChange={(e) => setOperation(e.target.value)}>
              <option value="expense">{tr('支出')}</option>
              <option value="transfer">{tr('转账')}</option>
            </select>
          </label>
          <label>
            {tr('付款账户')}
            <AccountPicker
              name="sourceId"
              accounts={accounts}
              value={sourceId}
              onChange={(id) => {
                setSource(id);
                if (target === id) setTarget('');
              }}
            />
          </label>
          {operation === 'transfer' && (
            <label>
              {tr('转入账户')}
              <AccountPicker
                name="targetId"
                accounts={accounts}
                value={target}
                onChange={setTarget}
                excludeId={sourceId}
              />
            </label>
          )}
          <label>
            {tr('金额')} ({sourceAccount?.currency})
            <input
              name="amount"
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
            />
          </label>
          {operation === 'transfer' && !same && (
            <label>
              {tr('实际到账')} ({targetAccount?.currency})
              <input
                name="received"
                required
                inputMode="decimal"
                pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
              />
            </label>
          )}
          <label>
            {tr('首次执行时间')}
            <input name="nextAt" type="datetime-local" required defaultValue={nowMinute()} />
          </label>
          <label>
            {tr('重复间隔（天，0为仅一次）')}
            <input
              name="intervalDays"
              type="number"
              min="0"
              max="3650"
              required
              defaultValue="30"
            />
          </label>
          <label>
            {tr('备注')}
            <textarea name="notes" maxLength={1800} />
          </label>
          <button className="primary" disabled={busy || (operation === 'transfer' && !target)}>
            {tr('保存计划')}
          </button>
        </form>
      )}
      {rows.map((p) => (
        <div className="schedule-row" key={p.id}>
          <span>
            {p.name} ·{' '}
            <strong className={p.operation === 'expense' ? 'danger-text' : undefined}>
              {money(p.amount, accounts.find((a) => a.id === p.sourceId)?.currency || '')}
            </strong>
            <small>
              {p.nextAt.replace('T', ' ')} ·{' '}
              {p.intervalDays ? tr('每') + ` ${p.intervalDays} ` + tr('天') : tr('仅一次')} ·{' '}
              {tr(p.completed ? '已完成' : p.enabled ? '启用' : '已暂停')}
            </small>
          </span>
          <button
            disabled={busy || p.completed}
            onClick={() =>
              void act(() => api('/schedules/' + p.id, 'PATCH', { enabled: !p.enabled }))
            }
          >
            {tr(p.enabled ? '暂停' : '启用')}
          </button>
          <button
            disabled={busy}
            onClick={() => void act(() => api('/schedules/' + p.id, 'DELETE'))}
          >
            {tr('删除')}
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
    </details>
  );
}
