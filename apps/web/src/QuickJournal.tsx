import React, { useState } from 'react';
import { repaymentFee } from './repayment';
import { AccountPicker } from './AccountPicker';
import { QuickTransfer } from './QuickTransfer';
import { money, positionAmount, type Position } from './api';
import { t as tr } from './i18n';
export type QuickEntry = {
  key: string;
  kind: 'balance' | 'transfer' | 'mark';
  id: string;
  positionId: string;
  title: string;
  currency: string;
  before?: string;
  after?: string;
  amount?: string;
  received?: string;
  fee?: string;
  targetCurrency?: string;
  date: string;
  previousMonth?: string | null;
  month?: string | null;
  markUpdatedAt?: string;
  undone?: boolean;
};
export const isPaidForMonth = (
  position: Pick<Position, 'kind' | 'side' | 'lastRepaymentMonth'>,
  month: string,
) =>
  position.kind === 'account' &&
  position.side === 'liability' &&
  position.lastRepaymentMonth === month;
export const isBookedToday = (position: Pick<Position, 'kind' | 'activityDate'>, day: string) =>
  position.kind === 'account' && position.activityDate === day;
export const quickAccountVisible = (
  position: Position,
  month: string,
  day: string,
  unpaidOnly: boolean,
  hideBooked: boolean,
) =>
  (!unpaidOnly ||
    (position.side === 'liability' && !position.archived && !isPaidForMonth(position, month))) &&
  (!hideBooked || !isBookedToday(position, day));
export const canQuickRepay = (position: Pick<Position, 'kind' | 'side' | 'amount' | 'archived'>) =>
  position.kind === 'account' &&
  position.side === 'liability' &&
  !position.archived &&
  !position.amount.startsWith('-') &&
  !/^0(?:\.0+)?$/.test(position.amount);
export function QuickJournal({
  entries,
  busy,
  undo,
}: {
  entries: QuickEntry[];
  busy: boolean;
  undo: (entry: QuickEntry) => void;
}) {
  return (
    <section className="quick-journal" aria-label={tr('本次快速记账')}>
      <h2>{tr('本次快速记账')}</h2>
      <p className="muted">{tr('本次保存成功的记录，可逐项撤回。')}</p>
      {!entries.length ? (
        <p className="muted">{tr('还没有保存记录')}</p>
      ) : (
        <ol>
          {entries.map((entry) => (
            <li key={entry.key} className={entry.undone ? 'undone' : ''}>
              <strong>{entry.title}</strong>
              {entry.kind === 'balance' && (
                <p>
                  {money(entry.before || '0', entry.currency)} →{' '}
                  {money(entry.after || '0', entry.currency)}
                </p>
              )}
              {entry.kind === 'transfer' && (
                <p>
                  {money(entry.amount || '0', entry.currency)}
                  {entry.targetCurrency !== entry.currency && (
                    <> → {money(entry.received || '0', entry.targetCurrency || entry.currency)}</>
                  )}
                </p>
              )}
              {entry.kind === 'transfer' && entry.fee && !/^-?0(?:\.0+)?$/.test(entry.fee) && (
                <p>
                  {tr(entry.fee.startsWith('-') ? '优惠' : '手续费')} ·{' '}
                  {money(
                    entry.fee.startsWith('-') ? repaymentFee(entry.fee) : entry.fee,
                    entry.currency,
                  )}
                </p>
              )}
              {entry.kind === 'mark' && (
                <p>{tr(entry.month ? '已标记本月还款' : '已取消本月标记')}</p>
              )}
              <small>{entry.date.replace('T', ' ')} · UTC+8</small>
              {entry.undone ? (
                <span className="badge">{tr('已撤回')}</span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => undo(entry)}
                >
                  {tr('撤回')}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
export function QuickRepayment({
  target,
  accounts,
  busy,
  submit,
}: {
  target: Position;
  accounts: Position[];
  busy: boolean;
  submit: (data: unknown) => void;
}) {
  const choices = accounts.filter(
    (p) => p.kind === 'account' && p.side === 'asset' && !p.archived && p.id !== target.id,
  );
  const [sourceId, setSourceId] = useState(choices[0]?.id || '');
  const source = choices.find((p) => p.id === sourceId);
  return (
    <section>
      <p className={positionAmount(target).startsWith('-') ? 'danger-text' : 'income-text'}>
        {tr('还款账户')}：{target.name} · {money(positionAmount(target), target.currency)}
      </p>
      <p className="muted">
        {tr('从付款账户转入欠款账户，双方余额同步更新；这里填写本次还款金额。')}
      </p>
      {!choices.length ? (
        <p>{tr('请先添加启用的资产账户作为付款账户。')}</p>
      ) : (
        <>
          <label>
            {tr('付款账户')}
            <AccountPicker
              name="quick-payment-source"
              accounts={choices}
              value={sourceId}
              onChange={setSourceId}
            />
          </label>
          {source && (
            <QuickTransfer
              key={source.id + target.id}
              source={source}
              target={target}
              busy={busy}
              changeSource={() => setSourceId('')}
              changeTarget={() => {}}
              fixedTarget
              repayment
              actionLabel={tr('确认还款')}
              submit={submit}
            />
          )}
        </>
      )}
    </section>
  );
}
