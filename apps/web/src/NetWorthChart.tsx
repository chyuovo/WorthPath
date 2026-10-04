import React, { useId, useState, type PointerEvent } from 'react';
import { money, type Total } from './api';
import { t as tr } from './i18n';

const series = [
  { key: 'assets', label: '总资产', color: '#199b76' },
  { key: 'liabilities', label: '总负债', color: '#c73542' },
  { key: 'net', label: '净资产', color: '#457bca' },
] as const;
type SeriesKey = (typeof series)[number]['key'];
const dateValue = (date: string) => Date.parse(date + 'T00:00:00Z');
export function nearestTrendIndex(rows: Pick<Total, 'date'>[], time: number) {
  let index = 0,
    distance = Infinity;
  rows.forEach((row, i) => {
    const next = Math.abs(dateValue(row.date) - time);
    if (next < distance) {
      index = i;
      distance = next;
    }
  });
  return index;
}
export function trendPath(
  rows: Total[],
  key: SeriesKey,
  x: (date: string) => number,
  y: (value: string) => number,
) {
  return rows
    .map((r, n) =>
      r.complete ? `${n === 0 || !rows[n - 1].complete ? 'M' : 'L'}${x(r.date)},${y(r[key])}` : '',
    )
    .join(' ');
}
export function NetWorthChart({ rows, base }: { rows: Total[]; base: string }) {
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    assets: true,
    liabilities: true,
    net: true,
  });
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const tooltipId = useId();
  const valid = rows.filter((r) => r.complete);
  if (valid.length < 2)
    return (
      <div className="empty">
        <h3>{tr('等待更多历史记录')}</h3>
        <p>{tr('至少两个日期的完整余额和汇率记录，才能绘制趋势。')}</p>
      </div>
    );
  const shown = series.filter((s) => visible[s.key]);
  const values = valid.flatMap((r) => shown.map((s) => Number(r[s.key])));
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values);
  const start = dateValue(rows[0].date),
    end = dateValue(rows.at(-1)!.date);
  const x = (date: string) => 35 + ((dateValue(date) - start) / (end - start || 1)) * 655;
  const y = (value: string) => 15 + ((max - Number(value)) / (max - min)) * 170;
  const active = rows.find((r) => r.date === activeDate);
  function point(event: PointerEvent<SVGSVGElement>) {
    if (!shown.length) return;
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const time = start + Math.max(0, Math.min(1, (position.x - 35) / 655)) * (end - start);
    setActiveDate(rows[nearestTrendIndex(rows, time)].date);
  }
  return (
    <div className="trend-chart">
      <div className="legend trend-legend" aria-label={tr('趋势折线显示设置')}>
        {series.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={visible[s.key]}
            style={{ color: s.color }}
            className={visible[s.key] ? 'trend-series' : 'trend-series is-hidden'}
            onClick={() => setVisible((v) => ({ ...v, [s.key]: !v[s.key] }))}
          >
            <span aria-hidden="true">{visible[s.key] ? '●' : '○'}</span> {tr(s.label)}
          </button>
        ))}
        <small>{base}</small>
      </div>
      {!shown.length ? (
        <p className="muted" role="status">
          {tr('已隐藏全部折线，点击上方名称可重新显示。')}
        </p>
      ) : (
        <>
          <p className="muted trend-help" id={tooltipId + '-help'}>
            {tr('点击名称切换折线；悬停或点击图表查看当天数据，方向键切换日期。')}
          </p>
          <div className="trend-plot">
            <svg
              viewBox="0 0 720 210"
              className="chart"
              role="img"
              tabIndex={0}
              aria-label={tr('资产、负债和净资产历史趋势')}
              aria-describedby={tooltipId + '-help'}
              onPointerMove={point}
              onPointerDown={point}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse' && document.activeElement !== e.currentTarget)
                  setActiveDate(null);
              }}
              onFocus={() => setActiveDate((current) => current || rows.at(-1)!.date)}
              onBlur={() => setActiveDate(null)}
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
                e.preventDefault();
                if (e.key === 'Escape') {
                  setActiveDate(null);
                  return;
                }
                const current = rows.findIndex((r) => r.date === activeDate);
                const next =
                  e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? rows.length - 1
                      : Math.max(
                          0,
                          Math.min(
                            rows.length - 1,
                            (current < 0 ? rows.length - 1 : current) +
                              (e.key === 'ArrowLeft' ? -1 : 1),
                          ),
                        );
                setActiveDate(rows[next].date);
              }}
            >
              <line x1="35" y1={y('0')} x2="690" y2={y('0')} stroke="#dbe4e2" />
              {shown.map((s) => (
                <path
                  key={s.key}
                  data-series={s.key}
                  d={trendPath(rows, s.key, x, y)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="3"
                />
              ))}
              {active && (
                <line
                  x1={x(active.date)}
                  x2={x(active.date)}
                  y1="15"
                  y2="185"
                  stroke="#899b94"
                  strokeDasharray="4 4"
                />
              )}
              {shown.map((s) =>
                valid.map((r) => (
                  <circle
                    key={s.key + r.date}
                    cx={x(r.date)}
                    cy={y(r[s.key])}
                    r={activeDate === r.date ? 5 : 2.5}
                    fill={s.color}
                  >
                    <title>{r.date + ' · ' + tr(s.label) + ' ' + money(r[s.key], base)}</title>
                  </circle>
                )),
              )}
            </svg>
            {active && (
              <section
                className="trend-tooltip"
                id={tooltipId}
                role="status"
                aria-label={tr('当天趋势数据')}
              >
                <strong>{active.date}</strong>
                {active.complete ? (
                  <dl>
                    {shown.map((s) => (
                      <React.Fragment key={s.key}>
                        <dt>
                          <span style={{ color: s.color }} aria-hidden="true">
                            ●
                          </span>{' '}
                          {tr(s.label)}
                        </dt>
                        <dd>{money(active[s.key], base)}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                ) : (
                  <p>{tr('当天估值或汇率不完整，无法显示完整总额。')}</p>
                )}
              </section>
            )}
          </div>
        </>
      )}
      <div className="chart-dates">
        <span>{rows[0].date}</span>
        <span>{rows.at(-1)!.date}</span>
      </div>
      {rows.some((r) => !r.complete) && (
        <p className="muted">{tr('缺失汇率的日期未绘制，曲线在该处断开。')}</p>
      )}
    </div>
  );
}
