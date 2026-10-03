import { useState } from 'react';
import { money, positionAmount, nowMinute, requestUuid, type Position } from './api';
import { t as tr } from './i18n';
export function QuickTransfer({
  source,
  target,
  busy,
  changeSource,
  changeTarget,
  submit,
}: {
  source: Position;
  target: Position;
  busy: boolean;
  changeSource: () => void;
  changeTarget: () => void;
  submit: (data: unknown) => void;
}) {
  const [amount, setAmount] = useState('');
  const [requestId] = useState(requestUuid);
  const same = source.currency === target.currency;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit({
          requestId,
          sourceId: source.id,
          targetId: target.id,
          amount,
          received: same ? amount : String(f.get('received')),
          fee: '0',
          notes: '',
          date: nowMinute(),
        });
      }}
    >
      <div className="quick-transfer-pair">
        <div>
          <small>{tr('转出账户')}</small>
          <strong>{source.name}</strong>
          <span>{money(positionAmount(source), source.currency)}</span>
          <button type="button" className="text" disabled={busy} onClick={changeSource}>
            {tr('重选')}
          </button>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <small>{tr('转入账户')}</small>
          <strong>{target.name}</strong>
          <span>{money(positionAmount(target), target.currency)}</span>
          <button type="button" className="text" disabled={busy} onClick={changeTarget}>
            {tr('重选')}
          </button>
        </div>
      </div>
      <label>
        {tr('转出金额（')}
        {source.currency}）
        <input
          name="amount"
          required
          inputMode="decimal"
          pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          autoFocus
        />
      </label>
      {!same && (
        <label>
          {tr('实际到账（')}
          {target.currency}）
          <input
            name="received"
            required
            inputMode="decimal"
            pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
            disabled={busy}
          />
        </label>
      )}
      <p className="muted">{tr('按当前时间记录，手续费为 0。跨币种请填写实际到账金额。')}</p>
      <button className="primary" disabled={busy}>
        {tr(busy ? '正在转账…' : '确认转账')}
      </button>
    </form>
  );
}
