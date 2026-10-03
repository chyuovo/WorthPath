import { useEffect, useState } from 'react';
import { api, money, today } from './api';
import { useToast } from './Toast';
import { t as tr } from './i18n';
type Day = { date: string; income: string; expense: string; complete: boolean };
type Entry = {
  id: string;
  name: string;
  direction: string;
  amount: string;
  currency: string;
  converted: string | null;
  notes: string;
};
export function Calendar({
  revealed,
  refreshVersion,
}: {
  revealed: boolean;
  refreshVersion: number;
}) {
  const [month, setMonth] = useState(today().slice(0, 7)),
    [selected, setSelected] = useState(today());
  const [days, setDays] = useState<Day[]>([]),
    [rows, setRows] = useState<Entry[]>([]),
    [base, setBase] = useState('CNY'),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  useToast(error, 'error');
  useEffect(() => {
    let active = true;
    setDays([]);
    setError('');
    void api<{ items: Day[]; baseCurrency: string }>('/calendar?month=' + month)
      .then((v) => {
        if (active) {
          setDays(v.items);
          setBase(v.baseCurrency);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [month, revealed, refreshVersion]);
  useEffect(() => {
    let active = true;
    setRows([]);
    setLoading(true);
    void api<{ items: Entry[] }>('/calendar/day?date=' + selected)
      .then((v) => {
        if (active) setRows(v.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected, revealed, refreshVersion]);
  const offset = (new Date(month + '-01T00:00:00Z').getUTCDay() + 6) % 7;
  const day = days.find((v) => v.date === selected);
  return (
    <section className="panel calendar-panel">
      <div className="panel-title">
        <h2>{tr('收支日历')}</h2>
        <input
          aria-label={tr('月份')}
          type="month"
          min="1900-01"
          max={today().slice(0, 7)}
          value={month}
          onChange={(e) => {
            if (e.target.value) {
              setMonth(e.target.value);
              setSelected(
                e.target.value === today().slice(0, 7) ? today() : e.target.value + '-01',
              );
            }
          }}
        />
      </div>
      <p className="muted">
        {tr('按账户余额变动估算；转账、借贷本金、初始余额和估值不计入。负债账户按相反方向计算。')}
      </p>
      <div className="calendar-grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((v) => (
          <span key={v} className="weekday">
            {tr(v)}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={'blank-' + i} />
        ))}
        {days.map((d) => (
          <button
            key={d.date}
            disabled={d.date > today()}
            aria-label={d.date}
            aria-pressed={d.date === selected}
            className={'calendar-day ' + (d.date === selected ? 'selected' : '')}
            onClick={() => setSelected(d.date)}
          >
            <strong>{Number(d.date.slice(-2))}</strong>
            {Number(d.income) > 0 && (
              <small className="income-text">+{money(d.income, base)}</small>
            )}
            {Number(d.expense) > 0 && (
              <small className="danger-text">−{money(d.expense, base)}</small>
            )}
            {!d.complete && <small>{tr('缺少汇率')}</small>}
          </button>
        ))}
      </div>
      <div className="calendar-detail">
        <div className="panel-title">
          <h3>
            {selected} · {tr('当日收支')}
          </h3>
          <button
            className="text"
            onClick={() => {
              setMonth(today().slice(0, 7));
              setSelected(today());
            }}
          >
            {tr('今天')}
          </button>
        </div>
        {day && (
          <p>
            {tr('收入')}：{day.complete ? money(day.income, base) : tr('缺少汇率')} ·{' '}
            <span className="danger-text">
              {tr('支出')}：{day.complete ? money(day.expense, base) : tr('缺少汇率')}
            </span>
          </p>
        )}
        {loading ? (
          <p>{tr('正在刷新数据…')}</p>
        ) : rows.length ? (
          rows.map((v) => (
            <article className="schedule-row" key={v.id}>
              <span>
                {v.name}
                <small className="notes-display">{v.notes}</small>
              </span>
              <strong className={v.direction === 'expense' ? 'danger-text' : 'income-text'}>
                {v.direction === 'expense' ? '−' : '+'}
                {money(v.amount, v.currency)}
              </strong>
              {v.converted === null && <small>{tr('缺少汇率')}</small>}
            </article>
          ))
        ) : (
          <p>{tr('当天没有收支记录')}</p>
        )}
      </div>
    </section>
  );
}
