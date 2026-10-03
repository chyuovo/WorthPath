import { useEffect, useRef, useState } from 'react';
import { api, money, type Position } from './api';
import { t as tr } from './i18n';
import { useToast } from './Toast';
type Quote = { metalType: string; currency: string; price: string; date: string; source: string };
type Data = { status: { state: string; message: string }; prices: Quote[] };
export function MetalPanel({
  position,
  refresh,
}: {
  position?: Position;
  refresh: () => Promise<void>;
}) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [data, setData] = useState<Data>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useToast(error, 'error');
  useToast(message, 'success');
  async function load() {
    setData(await api<Data>('/metals'));
  }
  useEffect(() => {
    let active = true;
    void api<Data>('/metals')
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [position]);
  useEffect(() => {
    if (data?.status.state !== 'updating') return;
    let active = true;
    const timer = setInterval(() => {
      void api<Data>('/metals')
        .then((v) => {
          if (active) {
            setData(v);
            if (v.status.state !== 'updating') {
              clearInterval(timer);
              void refreshRef.current().catch((e) => {
                if (active) setError(e.message);
              });
            }
          }
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            clearInterval(timer);
          }
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [data?.status.state]);
  async function act(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await load();
      await refresh();
      setMessage(tr(message));
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const quote = data?.prices.find(
    (q) => q.metalType === position?.metalType && q.currency === position?.currency,
  );
  return (
    <section className="panel">
      <h2>{tr('贵金属估价')}</h2>
      <p className="muted">
        {tr(
          '黄金与白银按重量及每克参考价估值。每日尝试更新，失败保留旧价；参考价不含工费与回收折价。',
        )}
      </p>
      {position && (
        <form
          key={
            position.id +
            String(position.metalGrams) +
            String(position.autoValuation) +
            String(position.metalType) +
            String(position.metalCostPerGram)
          }
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(
              () =>
                api('/metals/' + position.id, 'PUT', {
                  metalType: f.get('metalType'),
                  metalGrams: f.get('metalGrams'),
                  metalCostPerGram: f.get('metalCostPerGram') || null,
                  autoValuation: f.has('autoValuation'),
                }),
              '贵金属估价设置已保存',
            );
          }}
        >
          <label>
            {tr('贵金属品种')}
            <select name="metalType" defaultValue={position.metalType || 'gold'}>
              <option value="gold">{tr('黄金')}</option>
              <option value="silver">{tr('白银')}</option>
            </select>
          </label>
          <label>
            {tr('重量（克）')}
            <input
              name="metalGrams"
              required
              inputMode="decimal"
              pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
              defaultValue={position.metalGrams || ''}
            />
          </label>
          <label>
            {tr('买入价（每克，选填）')}（{position.currency}）
            <input
              name="metalCostPerGram"
              inputMode="decimal"
              defaultValue={position.metalCostPerGram || ''}
              pattern="(0|[1-9][0-9]{0,11})([.][0-9]{1,12})?"
            />
          </label>
          <p className="muted">
            {tr('买入成本按总克数计算；新持仓按克数和参考价估值。清空买入价后不显示盈亏。')}
          </p>
          {position.metalCost != null && (
            <p>
              {tr('买入成本')}：{position.metalCost} {position.currency} · {tr('估值盈亏')}：
              {position.metalProfit ?? tr('待估值')}{' '}
              {position.metalProfit != null ? position.currency : ''}
            </p>
          )}
          <label className="check-line">
            <input type="checkbox" name="autoValuation" defaultChecked={position.autoValuation} />
            {tr('随参考价自动记录估值')}
          </label>
          <button className="primary" disabled={busy || position.archived}>
            {tr('保存估价设置')}
          </button>
          <p className="muted">
            {tr('开启后，每日价格更新会新增估值历史；已有历史不会改写。关闭后可手动应用估价。')}
          </p>
        </form>
      )}
      <div className="actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void act(() => api('/metals/refresh', 'POST', {}), '贵金属参考价已更新')}
        >
          {tr('刷新贵金属价格')}
        </button>
        {position && (
          <button
            className="primary"
            disabled={busy || !quote || position.archived}
            onClick={() =>
              void act(() => api('/metals/' + position.id + '/value', 'POST', {}), '估价已记入历史')
            }
          >
            {tr('应用估价')}
          </button>
        )}
      </div>
      {quote && (
        <p>
          {tr('参考价')}：{money(quote.price, quote.currency)}/{tr('克')} ·{' '}
          {quote.date.slice(0, 10)} · {quote.source === 'manual' ? tr('手动') : 'Gold API'}
        </p>
      )}
      <p className={data?.status.state === 'error' ? 'danger-text' : 'muted'}>
        {tr(data?.status.message || '尚未尝试更新')}
      </p>
      {!position && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr('贵金属品种')}</th>
                <th>{tr('参考价')}</th>
                <th>{tr('报价日期')}</th>
                <th>{tr('来源')}</th>
              </tr>
            </thead>
            <tbody>
              {data?.prices.map((q) => (
                <tr key={q.metalType + q.currency + q.date}>
                  <td>{tr(q.metalType === 'gold' ? '黄金' : '白银')}</td>
                  <td>
                    {money(q.price, q.currency)}/{tr('克')}
                  </td>
                  <td>{q.date.slice(0, 10)}</td>
                  <td>{q.source === 'manual' ? tr('手动') : 'Gold API'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
