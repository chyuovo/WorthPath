import { AccountPicker } from './AccountPicker';
import { repaymentFee } from './repayment';
import { useState, type FormEvent } from 'react';
import { type Position, nowMinute, money, requestUuid, positionAmount } from './api';
import { t as tr } from './i18n';
export type DebtOperation = 'borrow' | 'lend' | 'collect' | 'repay';
export const operationLabel = (operation: string) =>
  tr(
    (
      {
        borrow: '借入到账',
        lend: '借出付款',
        collect: '收款',
        repay: '还款',
        transfer: '账户转账',
      } as Record<string, string>
    )[operation] || operation,
  );
export function DebtPaymentForm({
  accounts,
  debts,
  initialAccount,
  initialDebt,
  initialOperation,
  busy,
  submit,
}: {
  accounts: Position[];
  debts: Position[];
  initialAccount?: string;
  initialDebt?: string;
  initialOperation?: DebtOperation;
  busy: boolean;
  submit: (value: unknown) => void;
}) {
  const [requestId] = useState(requestUuid);
  const [accountId, setAccount] = useState(initialAccount || accounts[0]?.id || '');
  const [debtId, setDebt] = useState(initialDebt || debts[0]?.id || '');
  const debt = debts.find((p) => p.id === debtId),
    account = accounts.find((p) => p.id === accountId);
  const operations: DebtOperation[] =
    debt?.side === 'asset' ? ['collect', 'lend'] : ['repay', 'borrow'];
  const [chosen, setChosen] = useState<DebtOperation | undefined>(initialOperation);
  const operation = chosen && operations.includes(chosen) ? chosen : operations[0];
  const [amount, setAmount] = useState('');
  const same = debt?.currency === account?.currency;
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (operation === 'repay') {
      data.fee = repaymentFee(String(data.discount));
      delete data.discount;
    }
    submit(data);
  }
  if (!accounts.length || !debts.length)
    return <p>{tr('请先创建启用的资产账户和借入或借出债务。')}</p>;
  return (
    <form onSubmit={save} className="transfer-form">
      <input type="hidden" name="requestId" value={requestId} />
      <label>
        {tr('债务')}
        <select
          name="targetId"
          value={debtId}
          onChange={(event) => {
            setDebt(event.target.value);
            setChosen(undefined);
          }}
        >
          {debts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {tr(p.side === 'asset' ? '借款（待收）' : '欠款（待还）')} ·{' '}
              {money(positionAmount(p), p.currency)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr('操作')}
        <select
          name="operation"
          value={operation}
          onChange={(event) => setChosen(event.target.value as DebtOperation)}
        >
          {operations.map((value) => (
            <option key={value} value={value}>
              {operationLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr(operation === 'borrow' || operation === 'collect' ? '收款账户' : '付款账户')}
        <AccountPicker
          name="sourceId"
          accounts={accounts}
          value={accountId}
          onChange={setAccount}
        />
      </label>
      <p className="muted">
        {tr('账户与债务同时记账并自动建立关联；这里填写本次金额，不是操作后的余额。')}
      </p>
      <label>
        {tr('本次账户金额')} ({account?.currency})
        <input
          name="amount"
          required
          inputMode="decimal"
          pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <label>
        {tr('本次债务本金')} ({debt?.currency})
        {same ? (
          <input name="received" required readOnly value={amount} />
        ) : (
          <input
            name="received"
            key={debtId}
            required
            inputMode="decimal"
            pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
          />
        )}
      </label>
      <label>
        {tr(operation === 'repay' ? '还款优惠（负数表示手续费）' : '手续费 / 优惠')} (
        {account?.currency})
        <input
          name={operation === 'repay' ? 'discount' : 'fee'}
          key={operation}
          required
          defaultValue="0"
          inputMode="decimal"
          pattern="-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
        />
      </label>
      <p className="muted">
        {tr(
          operation === 'repay'
            ? '正数为优惠，负数为手续费，0 表示无优惠；只影响付款账户，优惠不能超过还款金额。跨币种请填写欠款减少金额。'
            : '手续费只影响账户余额：付款时额外扣除，收款时从到账金额扣除；负数表示优惠。',
        )}
      </p>
      <label>
        {tr('记录时间（UTC+8）')}
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
      <button className="primary" disabled={busy}>
        {busy ? tr('正在保存…') : operationLabel(operation)}
      </button>
    </form>
  );
}
