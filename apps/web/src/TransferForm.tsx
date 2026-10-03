import { AccountPicker } from './AccountPicker';
import { t as tr } from './i18n';
import { useState, type FormEvent } from 'react';
import { nowMinute, money, requestUuid, type Position } from './api';
export function TransferForm({
  accounts,
  busy,
  submit,
  initialSourceId,
}: {
  accounts: Position[];
  busy: boolean;
  submit: (data: unknown) => void;
  initialSourceId?: string;
}) {
  const [requestId] = useState(() => requestUuid());
  const [sourceId, setSource] = useState(initialSourceId || accounts[0]?.id || ''),
    [targetId, setTarget] = useState(
      accounts.find((p) => p.id !== (initialSourceId || accounts[0]?.id))?.id || '',
    ),
    [amount, setAmount] = useState('');
  const source = accounts.find((p) => p.id === sourceId),
    target = accounts.find((p) => p.id === targetId);
  const same = source?.currency === target?.currency;
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit(Object.fromEntries(new FormData(e.currentTarget)));
  }
  if (accounts.length < 2)
    return <p>{tr('请先创建至少两个启用中的账户。隐藏账户需验证密码后才能选择。')}</p>;
  return (
    <form onSubmit={save} className="transfer-form">
      <input type="hidden" name="requestId" value={requestId} />
      <p className="muted">
        {tr('转账会同时更新双方余额。余额不足时允许透支；手续费为负数时抵扣转出金额。')}
      </p>
      <label>
        {tr('转出账户')}
        <AccountPicker
          name="sourceId"
          accounts={accounts}
          value={sourceId}
          onChange={(id) => {
            setSource(id);
            if (targetId === id) setTarget(accounts.find((p) => p.id !== id)?.id || '');
          }}
        />
      </label>
      <label>
        {tr('转入账户')}
        <AccountPicker
          name="targetId"
          accounts={accounts}
          value={targetId}
          onChange={setTarget}
          excludeId={sourceId}
        />
      </label>
      <div className="form-columns">
        <label>
          {tr('转出金额（')}
          {source?.currency}）
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
          {tr('实际到账（')}
          {target?.currency}）
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
        <p className="notice warning">
          {tr('跨币种请填写银行实际到账金额；本次转账不修改公共参考汇率。')}
        </p>
      )}
      <label>
        {tr('手续费 / 优惠（')}
        {source?.currency}
        {tr('，优惠填负数）')}
        <input
          name="fee"
          required
          defaultValue="0"
          inputMode="decimal"
          pattern="-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
        />
      </label>
      <label>
        {tr('转账时间（北京时间）')}
        <input
          name="date"
          type="datetime-local"
          required
          defaultValue={nowMinute()}
          max={nowMinute()}
        />
      </label>
      <label>
        {tr('备注')}
        <textarea className="note-input" name="notes" maxLength={2000} rows={2} />
      </label>
      <button className="primary" disabled={busy || sourceId === targetId}>
        {busy ? tr('正在转账…') : tr('确认转账')}
      </button>
    </form>
  );
}
