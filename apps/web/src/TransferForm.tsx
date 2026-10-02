import { useState, type FormEvent } from 'react';
import { nowMinute, money, requestUuid, type Position } from './api';
export function TransferForm({
  accounts,
  busy,
  submit,
}: {
  accounts: Position[];
  busy: boolean;
  submit: (data: unknown) => void;
}) {
  const [requestId] = useState(() => requestUuid());
  const [sourceId, setSource] = useState(accounts[0]?.id || ''),
    [targetId, setTarget] = useState(accounts[1]?.id || ''),
    [amount, setAmount] = useState('');
  const source = accounts.find((p) => p.id === sourceId),
    target = accounts.find((p) => p.id === targetId);
  const same = source?.currency === target?.currency;
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  if (accounts.length < 2)
    return <p>请先创建至少两个启用中的资产账户。隐藏账户需验证密码后才能选择。</p>;
  return (
    <form onSubmit={save} className="transfer-form">
      <input type="hidden" name="requestId" value={requestId} />
      <p className="muted">
        双方余额同时更新。手续费从转出账户额外扣除；转账时间不能早于双方最新余额记录。
      </p>
      <label>
        转出账户
        <select name="sourceId" value={sourceId} onChange={(e) => setSource(e.target.value)}>
          {accounts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {money(p.amount, p.currency)}
            </option>
          ))}
        </select>
      </label>
      <label>
        转入账户
        <select name="targetId" value={targetId} onChange={(e) => setTarget(e.target.value)}>
          {accounts.map((p) => (
            <option key={p.id} value={p.id} disabled={p.id === sourceId}>
              {p.name} · {p.currency}
            </option>
          ))}
        </select>
      </label>
      <div className="form-columns">
        <label>
          转出金额（{source?.currency}）
          <input
            name="amount"
            required
            inputMode="decimal"
            pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          实际到账（{target?.currency}）
          {same ? (
            <input name="received" required readOnly value={amount} />
          ) : (
            <input
              key={targetId}
              name="received"
              required
              inputMode="decimal"
              pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
            />
          )}
        </label>
      </div>
      {!same && (
        <p className="notice warning">跨币种请填写银行实际到账金额；本次转账不修改公共参考汇率。</p>
      )}
      <label>
        额外手续费（{source?.currency}）
        <input
          name="fee"
          required
          defaultValue="0"
          inputMode="decimal"
          pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
        />
      </label>
      <label>
        转账时间（北京时间）
        <input
          name="date"
          type="datetime-local"
          required
          defaultValue={nowMinute()}
          max={nowMinute()}
        />
      </label>
      <label>
        备注
        <textarea className="note-input" name="notes" maxLength={2000} rows={2} />
      </label>
      <button className="primary" disabled={busy || sourceId === targetId}>
        {busy ? '正在转账…' : '确认转账'}
      </button>
    </form>
  );
}
