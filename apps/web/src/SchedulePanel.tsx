import { useEffect, useState, useRef } from 'react';
import { api, money, nowMinute, type Position } from './api';
import { AccountPicker } from './AccountPicker';
import { useToast } from './Toast';
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
  targetId: string | null;
  received: string;
  notes: string;
};
export function SchedulePanel({
  accounts,
  refresh,
}: {
  accounts: Position[];
  refresh: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Plan[]>([]),
    [editor, setEditor] = useState<Plan | null | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useToast(error, 'error');
  useToast(status, 'success');
  useEffect(() => {
    if (editor !== undefined) dialog.current?.showModal();
  }, [editor]);
  function openEditor(plan: Plan | null) {
    setError('');
    setOperation(plan?.operation ?? 'expense');
    setSource(plan?.sourceId ?? accounts[0]?.id ?? '');
    setTarget(plan?.targetId ?? '');
    setAmount(plan?.amount ?? '');
    setEditor(plan);
  }
  const [operation, setOperation] = useState('expense'),
    [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [amount, setAmount] = useState('');
  const sourceAccounts =
    operation === 'expense' ? accounts.filter((p) => p.side === 'asset') : accounts;
  const sourceId = sourceAccounts.some((p) => p.id === source)
    ? source
    : sourceAccounts[0]?.id || '';
  const sourceAccount = accounts.find((p) => p.id === sourceId),
    targetAccount = accounts.find((p) => p.id === target);
  const same = sourceAccount?.currency === targetAccount?.currency;
  useEffect(() => {
    let active = true;
    setRows([]);
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
    <section className="schedule-panel">
      <h2>
        {tr('定时计划')} ({rows.length})
      </h2>
      <p className="muted">
        {tr('打开账户页或点击执行时处理到期计划。每次最多执行20项，离线期间的计划会逐次补记。')}
      </p>
      <div className="actions">
        <button type="button" disabled={busy || !accounts.length} onClick={() => openEditor(null)}>
          {tr('添加计划')}
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
      {editor !== undefined && (
        <dialog
          ref={dialog}
          className="picker-dialog schedule-dialog"
          aria-label={tr(editor ? '修改计划' : '添加计划')}
          onCancel={(e) => {
            if (busy) e.preventDefault();
            else setEditor(undefined);
          }}
          onClose={() => setEditor(undefined)}
        >
          <div className="panel-title">
            <h2>{tr(editor ? '修改计划' : '添加计划')}</h2>
            <button
              type="button"
              className="icon"
              aria-label={tr('关闭')}
              disabled={busy}
              onClick={() => setEditor(undefined)}
            >
              ×
            </button>
          </div>
          <form
            key={editor?.id ?? 'new'}
            onSubmit={(e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(e.currentTarget));
              void act(async () => {
                await api(
                  editor ? '/schedules/' + editor.id : '/schedules',
                  editor ? 'PUT' : 'POST',
                  {
                    ...data,
                    operation,
                    sourceId,
                    targetId: operation === 'transfer' ? target : null,
                    received: operation === 'transfer' ? (same ? amount : data.received) : '0',
                    intervalDays: Number(data.intervalDays),
                  },
                );
                setEditor(undefined);
                setStatus(tr('计划已保存'));
              });
            }}
          >
            <label>
              {tr('计划名称')}
              <input name="name" required maxLength={100} defaultValue={editor?.name} />
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
                accounts={sourceAccounts}
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
                  defaultValue={editor?.received}
                  required
                  inputMode="decimal"
                  pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
                />
              </label>
            )}
            <label>
              {tr(editor ? '下次执行时间' : '首次执行时间')}
              <input
                name="nextAt"
                type="datetime-local"
                required
                defaultValue={editor?.nextAt ?? nowMinute()}
              />
            </label>
            <label>
              {tr('重复间隔（天，0为仅一次）')}
              <input
                name="intervalDays"
                type="number"
                min="0"
                max="3650"
                required
                defaultValue={editor?.intervalDays ?? 30}
              />
            </label>
            <label>
              {tr('备注')}
              <textarea
                className="note-input"
                name="notes"
                maxLength={2000}
                defaultValue={editor?.notes}
              />
            </label>
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => setEditor(undefined)}>
                {tr('取消')}
              </button>
              <button className="primary" disabled={busy || (operation === 'transfer' && !target)}>
                {tr('保存计划')}
              </button>
            </div>
          </form>
        </dialog>
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
            disabled={
              busy ||
              p.completed ||
              !accounts.some((a) => a.id === p.sourceId) ||
              (!!p.targetId && !accounts.some((a) => a.id === p.targetId))
            }
            onClick={() => openEditor(p)}
          >
            {tr('修改计划')}
          </button>
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
    </section>
  );
}
