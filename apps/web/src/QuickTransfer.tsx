import { useState } from 'react';
import { repaymentFee } from './repayment';
import { money, positionAmount, nowMinute, requestUuid, type Position } from './api';
import { t as tr } from './i18n';
export function QuickTransfer({
  source,
  target,
  busy,
  changeSource,
  changeTarget,
  submit,
  actionLabel,
  fixedTarget,
  repayment,
}: {
  source: Position;
  target: Position;
  busy: boolean;
  changeSource: () => void;
  changeTarget: () => void;
  submit: (data: unknown) => void;
  actionLabel?: string;
  fixedTarget?: boolean;
  repayment?: boolean;
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
          fee: repayment ? repaymentFee(String(f.get('discount'))) : '0',
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
          {!fixedTarget && (
            <button type="button" className="text" disabled={busy} onClick={changeTarget}>
              {tr('重选')}
            </button>
          )}
        </div>
      </div>
      <label>
        {tr(repayment ? '还款金额（' : '转出金额（')}
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
          {tr(repayment ? '欠款减少金额（' : '实际到账（')}
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
      {repayment && (
        <label>
          {tr('还款优惠（负数表示手续费）')} ({source.currency})
          <input
            name="discount"
            required
            defaultValue="0"
            inputMode="decimal"
            pattern="-?(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
            disabled={busy}
          />
        </label>
      )}
      <p className="muted">
        {tr(
          repayment
            ? '正数为优惠，负数为手续费，0 表示无优惠；只影响付款账户，优惠不能超过还款金额。跨币种请填写欠款减少金额。'
            : '按当前时间记录，手续费为 0。跨币种请填写实际到账金额。',
        )}
      </p>
      <button className="primary" disabled={busy}>
        {busy ? tr('正在保存…') : actionLabel || tr('确认转账')}
      </button>
    </form>
  );
}
