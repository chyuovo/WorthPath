import { useState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import {
  LayoutDashboard,
  Wallet,
  Landmark,
  HandCoins,
  History as HistoryIcon,
  Settings,
  ArrowUpRight,
  Plus,
  LogOut,
  ArrowLeft,
  X,
  Download,
  Upload,
  RefreshCw,
  TrendingUp,
  ShieldCheck,
} from 'lucide-react';
import {
  api,
  ApiError,
  currencies,
  money,
  today,
  nowMinute,
  displayTime,
  type User,
  type Position,
  type Overview,
  type History,
  type Rate,
  type Total,
} from './api';
import './style.css';
import { IconLibrary, iconUrl } from './IconLibrary';
const labels: Record<string, string> = {
  overview: '资产总览',
  account: '账户',
  asset: '独立资产',
  debt: '债务',
  history: '变化记录',
  settings: '设置与备份',
};
const categories: Record<string, [string, string][]> = {
  account: [
    ['bank', '银行账户'],
    ['cash', '现金'],
    ['investment', '投资账户'],
    ['credit_card', '信用卡'],
    ['loan', '贷款账户'],
    ['other', '其他'],
  ],
  asset: [
    ['property', '房产'],
    ['vehicle', '车辆'],
    ['gold', '贵金属'],
    ['other', '其他资产'],
  ],
  debt: [
    ['mortgage', '房贷'],
    ['car_loan', '车贷'],
    ['personal', '个人借款'],
    ['other', '其他债务'],
  ],
};
const categoryLabel = (p: Position) =>
  categories[p.kind]?.find(([v]) => v === p.category)?.[1] || p.category;
function Currency({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {currencies.map((c) => (
        <option key={c}>{c}</option>
      ))}
    </select>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="veil"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section role="dialog" aria-modal="true" aria-label={title} className="modal">
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Wallet size={32} />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Chart({ rows, base }: { rows: Total[]; base: string }) {
  const valid = rows.filter((r) => r.complete);
  if (valid.length < 2)
    return (
      <Empty title="等待更多历史记录" body="至少两个日期的完整余额和汇率记录，才能绘制趋势。" />
    );
  const values = valid.flatMap((r) => [Number(r.assets), Number(r.liabilities), Number(r.net)]),
    min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    w = 720,
    h = 210;
  const x = (date: string) =>
    35 +
    ((new Date(date).getTime() - new Date(rows[0].date).getTime()) /
      (new Date(rows.at(-1)!.date).getTime() - new Date(rows[0].date).getTime() || 1)) *
      (w - 65);
  const y = (v: string) => 15 + ((max - Number(v)) / (max - min)) * (h - 40);
  const series = ['assets', 'liabilities', 'net'] as const;
  return (
    <>
      <div className="legend">
        <span className="green">总资产</span>
        <span className="orange">总负债</span>
        <span className="blue">净资产</span>
        <small>{base}</small>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="chart"
        role="img"
        aria-label="资产、负债和净资产历史趋势"
      >
        <line x1="35" y1={y('0')} x2="690" y2={y('0')} stroke="#dbe4e2" />
        {series.map((s, i) => (
          <path
            key={s}
            d={rows
              .map((r, n) =>
                r.complete
                  ? `${n === 0 || !rows[n - 1].complete ? 'M' : 'L'}${x(r.date)},${y(r[s])}`
                  : '',
              )
              .join(' ')}
            fill="none"
            stroke={['#199b76', '#dc9463', '#457bca'][i]}
            strokeWidth="3"
          />
        ))}
        {valid.map((r) => (
          <circle key={r.date} cx={x(r.date)} cy={y(r.net)} r="4" fill="#457bca">
            <title>
              {r.date} 净资产 {money(r.net, base)}
            </title>
          </circle>
        ))}
      </svg>
      <div className="chart-dates">
        <span>{rows[0].date}</span>
        <span>{rows.at(-1)!.date}</span>
      </div>
      {rows.some((r) => !r.complete) && (
        <p className="muted">缺失汇率的日期未绘制，曲线在该处断开。</p>
      )}
    </>
  );
}
export default function App() {
  const sessionGeneration = useRef(0),
    loadGeneration = useRef(0);
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [register, setRegister] = useState(false),
    [page, setPage] = useState('overview'),
    [positions, setPositions] = useState<Position[]>([]),
    [overview, setOverview] = useState<Overview | null>(null),
    [rates, setRates] = useState<Rate[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState<{ kind: string; p?: Position; h?: History } | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const [fxStatus, setFxStatus] = useState<{
    state: string;
    message: string;
    attemptedAt: string | null;
  } | null>(null);
  const [backup, setBackup] = useState<unknown>(null),
    [preview, setPreview] = useState<{
      positions: number;
      revisions: number;
      rates: number;
      message: string;
      baseCurrency: string;
      currentBaseCurrency: string;
    } | null>(null);
  const [clearStep, setClearStep] = useState(0);
  const activityAt = useRef(0);
  function clearAccount() {
    setClearStep(0);
    activityAt.current = 0;
    sessionGeneration.current++;
    loadGeneration.current++;
    setUser(null);
    setPositions([]);
    setOverview(null);
    setRates([]);
    setFxStatus(null);
    setModal(null);
    setSelected(null);
    setBackup(null);
    setPreview(null);
    setPage('overview');
    setRegister(false);
    setLoading(false);
    setSuccess('');
  }
  const report = (e: unknown) => {
    setError(e instanceof Error ? e.message : '操作失败');
    if (e instanceof ApiError && e.status === 401) {
      clearAccount();
    }
  };
  async function load() {
    const session = sessionGeneration.current,
      request = ++loadGeneration.current;
    setLoading(true);
    try {
      const [p, o, s] = await Promise.all([
        api<Position[]>('/positions'),
        api<Overview>('/overview'),
        api<
          User & {
            rates: Rate[];
            fxStatus: { state: string; message: string; attemptedAt: string | null };
          }
        >('/settings'),
      ]);
      if (session !== sessionGeneration.current || request !== loadGeneration.current) return;
      if (o.revealed !== !!s.revealed) {
        setPositions([]);
        setOverview(null);
        setSelected(null);
        setModal(null);
        void load();
        return;
      }
      if (!activityAt.current && s.lastActivity) activityAt.current = +new Date(s.lastActivity);
      setPositions(s.revealed ? p : p.filter((position) => !position.hidden));
      setOverview(o);
      setRates(s.rates);
      setFxStatus(s.fxStatus);
      setUser(s);
    } catch (e) {
      if (session === sessionGeneration.current && request === loadGeneration.current) report(e);
    } finally {
      if (session === sessionGeneration.current && request === loadGeneration.current)
        setLoading(false);
    }
  }
  useEffect(() => {
    const session = sessionGeneration.current;
    void api<User>('/auth/me')
      .then((u) => {
        if (session !== sessionGeneration.current) return;
        setUser(u);
        return load();
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) report(e);
      })
      .finally(() => setBoot(false));
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page, selected]);
  useEffect(() => {
    if (!user) return;
    const session = sessionGeneration.current;
    let lastSent = 0,
      pending = false,
      revealExpired = false;
    const activity = () => {
      if (!document.hidden) {
        activityAt.current = Date.now();
        if (Date.now() - lastSent > 15000 && !pending) {
          pending = true;
          lastSent = Date.now();
          void api('/auth/activity', 'POST')
            .catch((e) => {
              if (session === sessionGeneration.current) report(e);
            })
            .finally(() => {
              pending = false;
            });
        }
      }
    };
    const check = window.setInterval(() => {
      if (
        user.idleMinutes &&
        activityAt.current &&
        Date.now() - activityAt.current >= user.idleMinutes * 60000
      ) {
        clearAccount();
        setError('长时间无操作，已自动退出登录');
        void api('/auth/logout', 'POST').catch(() => {});
      } else if (!revealExpired && user.revealUntil && Date.now() >= +new Date(user.revealUntil)) {
        revealExpired = true;
        setPositions([]);
        setOverview(null);
        setSelected(null);
        setModal(null);
        void load();
      }
    }, 1000);
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    return () => {
      window.clearInterval(check);
      events.forEach((e) => window.removeEventListener(e, activity));
    };
  }, [user?.idleMinutes, user?.revealUntil, !!user]);
  async function act(work: () => Promise<unknown>, message: string) {
    const session = sessionGeneration.current;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await work();
      if (session !== sessionGeneration.current) return;
      setSuccess(
        result &&
          typeof result === 'object' &&
          'message' in result &&
          typeof result.message === 'string'
          ? result.message
          : message,
      );
      setModal(null);
      await load();
    } catch (e) {
      if (session === sessionGeneration.current) report(e);
    } finally {
      setBusy(false);
    }
  }
  async function auth(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const session = ++sessionGeneration.current;
    setBusy(true);
    setError('');
    try {
      const u = await api<User>('/auth/' + (register ? 'register' : 'login'), 'POST', {
        username: f.get('username'),
        password: f.get('password'),
      });
      if (session !== sessionGeneration.current) return;
      setPage('overview');
      setSelected(null);
      setModal(null);
      activityAt.current = Date.now();
      setUser(u);
      await load();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    sessionGeneration.current++;
    setBusy(true);
    try {
      await api('/auth/logout', 'POST');
      clearAccount();
      setError('');
      setSuccess('');
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  const p = positions.find((p) => p.id === selected),
    newAction = (
      <button
        className="primary"
        onClick={() => setModal({ kind: page === 'overview' ? 'account' : page })}
      >
        <Plus size={17} />
        新增{page === 'overview' ? '账户' : labels[page]}
      </button>
    );
  if (boot) return <div className="splash">WorthPath · 正在连接你的资产空间…</div>;
  if (!user)
    return (
      <div className="auth-layout">
        <section className="auth-story">
          <div className="brand">
            <span>W</span> WorthPath
          </div>
          <div>
            <p className="eyebrow">YOUR WEALTH, IN PERSPECTIVE</p>
            <h1>
              让每一步积累，
              <br />
              都有清晰的方向。
            </h1>
            <p>
              在一个空间里，连接你的账户、资产与债务。
              <br />
              看见当下，也看见净资产的每一次变化。
            </p>
            <div className="story-line">
              <TrendingUp size={32} />
              <span>
                关注长期积累
                <br />
                <small>从第一份真实资产开始</small>
              </span>
            </div>
          </div>
          <small>个人资产管理 · 多币种 · 历史追踪</small>
        </section>
        <section className="auth-form">
          <div>
            <p className="eyebrow">开始你的资产之路</p>
            <h2>{register ? '创建账号' : '欢迎回来'}</h2>
            <p className="muted">
              {register ? '建立属于你的私人资产空间' : '登录以查看你的资产与负债'}
            </p>
            {error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            <form onSubmit={auth}>
              <Field label="账号">
                <input
                  name="username"
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={64}
                  placeholder="输入账号（至少 3 个字符）"
                />
              </Field>
              <Field label="密码">
                <input
                  name="password"
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  minLength={10}
                  maxLength={72}
                  placeholder="至少 10 个字符，最多 72 字节"
                />
              </Field>
              <button className="primary full" disabled={busy}>
                {busy ? '正在处理…' : register ? '注册并进入' : '登录'}
                <ArrowUpRight size={18} />
              </button>
            </form>
            <p>
              {register ? '已有账号？' : '还没有账号？'}{' '}
              <button
                className="text"
                onClick={() => {
                  setRegister(!register);
                  setError('');
                }}
              >
                {register ? '登录' : '创建账号'}
              </button>
            </p>
            <p className="privacy">
              <ShieldCheck size={16} />
              个人数据按登录身份隔离
            </p>
          </div>
        </section>
      </div>
    );
  const nav = [
    ['overview', LayoutDashboard],
    ['account', Wallet],
    ['asset', Landmark],
    ['debt', HandCoins],
    ['history', HistoryIcon],
    ['settings', Settings],
  ] as const;
  return (
    <div className={'app' + (user.showSidebar === false ? ' sidebar-hidden' : '')}>
      {user.showSidebar !== false && (
        <aside className="sidebar">
          <div className="brand">
            <span>W</span> WorthPath
          </div>
          <p className="nav-caption">我的资产空间</p>
          <nav>
            {nav.map(([key, Icon]) => (
              <button
                key={key}
                className={page === key ? 'active' : ''}
                onClick={() => {
                  setPage(key);
                  setSelected(null);
                }}
              >
                <Icon size={19} />
                <span>{labels[key]}</span>
              </button>
            ))}
          </nav>
          <div className="side-bottom">
            <div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{user.username}</strong>
              <small>个人账户 · {user.baseCurrency}</small>
            </div>
            <button
              className="icon"
              aria-label="退出登录"
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </aside>
      )}
      <main>
        <header className="topbar">
          <span>个人财务 / {labels[page]}</span>
          {user.showSidebar === false && (
            <select
              aria-label="页面导航"
              value={page}
              onChange={(e) => {
                setPage(e.target.value);
                setSelected(null);
              }}
            >
              {nav.map(([key]) => (
                <option key={key} value={key}>
                  {labels[key]}
                </option>
              ))}
            </select>
          )}
          <div>
            <span className="currency-pill">本位币 {user.baseCurrency}</span>
            <button
              className="icon"
              aria-label="刷新数据"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <div className="content">
          <div className="privacy-toolbar">
            <span>
              {overview?.revealed
                ? '当前包含隐藏项目 · 验证 5 分钟后自动锁定'
                : '当前不包含隐藏账户、资产和债务，净资产按此范围计算'}
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                overview?.revealed
                  ? void act(() => api('/auth/lock', 'POST'), '隐藏项目已锁定')
                  : setModal({ kind: 'reveal' })
              }
            >
              {overview?.revealed ? '锁定隐藏项目' : '显示隐藏资产（验证密码）'}
            </button>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORTHPATH / {today()}</p>
              <h1>
                {p?.iconId && (
                  <img className="detail-icon" src={iconUrl(p.iconId)} alt="账户图标" />
                )}
                {p ? p.name : labels[page]}
              </h1>
              <p className="muted">
                {page === 'overview'
                  ? '你的财富全貌，从这里开始。'
                  : page === 'settings'
                    ? '让数据始终可控，让换算清晰可靠。'
                    : '保留原币金额，追踪长期变化。'}
              </p>
            </div>
            {['overview', 'account', 'asset', 'debt'].includes(page) && !p && newAction}
          </div>
          {error && (
            <div className="notice error" role="alert">
              {error}
              <button className="text" onClick={() => setError('')}>
                关闭
              </button>
            </div>
          )}
          {success && (
            <div className="notice success" role="status">
              {success}
              <button className="text" onClick={() => setSuccess('')}>
                关闭
              </button>
            </div>
          )}
          {loading && (
            <p role="status" className="muted">
              正在刷新数据…
            </p>
          )}
          {page === 'overview' && overview && (
            <>
              {!overview.complete && (
                <div className="notice warning">
                  缺少 {overview.missing.join('、')} 到 {user.baseCurrency}{' '}
                  的汇率。以下仅展示已能换算的部分，不能作为完整总额。
                  <button className="text" onClick={() => setPage('settings')}>
                    设置汇率
                  </button>
                </div>
              )}
              <div className="metrics">
                {[
                  ['总资产', overview.assets, 'asset'],
                  ['总负债', overview.liabilities, 'debt'],
                  ['净资产', overview.net, 'net'],
                ].map(([title, value, cls]) => (
                  <section className={'metric ' + cls} key={title}>
                    <div>
                      <span>
                        {title}
                        {!overview.complete ? '（部分）' : ''}
                      </span>
                      <ArrowUpRight size={18} />
                    </div>
                    <strong>{money(value, user.baseCurrency)}</strong>
                    <small>
                      {title === '净资产'
                        ? '总资产 − 总负债'
                        : title === '总资产'
                          ? '账户资产 + 独立资产'
                          : '负债账户 + 独立债务'}
                    </small>
                  </section>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>净资产轨迹</h2>
                    <span className="badge">按业务日期</span>
                  </div>
                  <Chart rows={overview.trend} base={user.baseCurrency} />
                  <p className="muted">按当时可用汇率重放；更正历史后重新计算。归档项目仍计入。</p>
                </section>
                <section className="panel">
                  <h2>资产与负债组成</h2>
                  {positions.length ? (
                    ['account', 'asset', 'debt'].map((k) => (
                      <button
                        className="composition"
                        key={k}
                        onClick={() => {
                          setPage(k);
                          setSelected(null);
                        }}
                      >
                        <span>
                          {labels[k]}
                          <small>{positions.filter((p) => p.kind === k).length} 个项目</small>
                        </span>
                        <ArrowUpRight size={18} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      title="从一个账户开始"
                      body="添加银行、现金或投资账户，建立你的资产全貌。"
                      action={newAction}
                    />
                  )}
                  <p className="privacy">
                    <ShieldCheck size={15} />
                    关联关系不会重复计入总额
                  </p>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h2>最近变化</h2>
                  <button className="text" onClick={() => setPage('history')}>
                    查看全部 →
                  </button>
                </div>
                <HistoryTable
                  rows={overview.recent}
                  open={(id) => {
                    setSelected(id);
                    setPage(positions.find((p) => p.id === id)?.kind || 'account');
                  }}
                />
              </section>
              <div className="fx-caption">
                本位币 {user.baseCurrency} · 汇率日期：
                {[
                  ...new Set(
                    overview.items
                      .filter((i) => i.currency !== user.baseCurrency && i.rateDate)
                      .map((i) => i.rateDate),
                  ),
                ].join(' / ') || '尚无外币汇率'}{' '}
                · 每日尝试更新，失败保留已有数据；旧日期汇率可能产生换算偏差。
              </div>
              {overview.trend.length > 1 && (
                <section className="panel">
                  <h2>变化归因</h2>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>余额 / 估值变化</th>
                          <th>汇率变化</th>
                          <th>净资产</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.trend.slice(-10).map((r) => (
                          <tr key={r.date}>
                            <td>{r.date}</td>
                            <td>
                              {r.balanceChange === null || r.balanceChange === undefined
                                ? '—'
                                : money(r.balanceChange, user.baseCurrency)}
                            </td>
                            <td>
                              {r.fxChange === null || r.fxChange === undefined
                                ? '—'
                                : money(r.fxChange, user.baseCurrency)}
                            </td>
                            <td>{r.complete ? money(r.net, user.baseCurrency) : '汇率不完整'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
          {['account', 'asset', 'debt'].includes(page) &&
            (p ? (
              <>
                <button className="text back" onClick={() => setSelected(null)}>
                  <ArrowLeft size={16} />
                  返回列表
                </button>
                <section className="panel detail-summary">
                  <div>
                    <span className="badge">
                      {categoryLabel(p)} · {p.side === 'asset' ? '资产' : '负债'}
                      {p.archived ? ' · 已归档' : ''}
                    </span>
                    <h2>{money(p.amount, p.currency)}</h2>
                    {p.hidden && <span className="badge">隐藏项目</span>}
                    <p className="muted">
                      本位币：
                      {overview?.items.find((i) => i.id === p.id)?.converted !== null
                        ? money(
                            overview?.items.find((i) => i.id === p.id)?.converted || '0',
                            user.baseCurrency,
                          )
                        : '缺少汇率'}
                    </p>
                    <p>{p.notes || '暂无备注'}</p>
                    <small>币种和资产负债属性创建后固定。归档项目仍计入总览。</small>
                  </div>
                  <div className="actions">
                    <button className="secondary" onClick={() => setModal({ kind: 'edit', p })}>
                      编辑资料
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(
                          () =>
                            api('/positions/' + p.id, 'PATCH', {
                              name: p.name,
                              category: p.category,
                              notes: p.notes,
                              archived: !p.archived,
                              hidden: p.hidden,
                            }),
                          p.archived ? '项目已恢复' : '项目已归档',
                        )
                      }
                    >
                      {p.archived ? '恢复项目' : '归档项目'}
                    </button>
                    <button
                      className="primary"
                      disabled={p.archived}
                      onClick={() => setModal({ kind: 'revision', p })}
                    >
                      更新{p.kind === 'asset' ? '估值' : '余额'}
                    </button>
                  </div>
                </section>
                {p.kind === 'debt' && (
                  <section className="panel">
                    <div className="panel-title">
                      <h2>关联资产与账户</h2>
                      <button className="text" onClick={() => setModal({ kind: 'links', p })}>
                        管理关联
                      </button>
                    </div>
                    <p className="muted">只展示关系，不改变资产或债务的统计。</p>
                    {p.outgoing.length ? (
                      p.outgoing.map((l) => (
                        <button
                          className="secondary"
                          key={l.targetId}
                          onClick={() => {
                            setSelected(l.targetId);
                            setPage(positions.find((v) => v.id === l.targetId)?.kind || 'asset');
                          }}
                        >
                          {positions.find((v) => v.id === l.targetId)?.name}
                        </button>
                      ))
                    ) : (
                      <p>尚未关联</p>
                    )}
                  </section>
                )}
                <section className="panel">
                  <h2>余额与估值历史</h2>
                  <p className="muted">
                    每次更新保留独立历史，同日按记录顺序展示。错误记录可单独更正，后续变化自动重算。
                  </p>
                  <HistoryTable
                    rows={[...p.history].reverse()}
                    correct={p.archived ? undefined : (h) => setModal({ kind: 'correction', p, h })}
                  />
                </section>
              </>
            ) : (
              <section className="panel">
                {positions.some((p) => p.kind === page) ? (
                  <div className="position-grid">
                    {positions
                      .filter((p) => p.kind === page)
                      .map((p) => (
                        <button
                          className="position-card"
                          key={p.id}
                          onClick={() => setSelected(p.id)}
                        >
                          <div>
                            <span className="position-icon">
                              {p.iconId ? (
                                <img src={iconUrl(p.iconId)} alt="账户图标" />
                              ) : p.kind === 'asset' ? (
                                <Landmark />
                              ) : p.kind === 'debt' ? (
                                <HandCoins />
                              ) : (
                                <Wallet />
                              )}
                            </span>
                            <ArrowUpRight size={18} />
                          </div>
                          <h3>{p.name}</h3>
                          <p>
                            {categoryLabel(p)} · {p.side === 'asset' ? '资产' : '负债'}
                            {p.archived ? ' · 已归档' : ''}
                          </p>
                          <strong>{money(p.amount, p.currency)}</strong>
                          <small>
                            折合{' '}
                            {overview?.items.find((i) => i.id === p.id)?.converted === null
                              ? '缺少汇率'
                              : money(
                                  overview?.items.find((i) => i.id === p.id)?.converted || '0',
                                  user.baseCurrency,
                                )}
                          </small>
                        </button>
                      ))}
                  </div>
                ) : (
                  <Empty
                    title={'还没有' + labels[page]}
                    body="添加真实数据后，这里将展示原币余额和历史变化。"
                    action={newAction}
                  />
                )}
              </section>
            ))}
          {page === 'history' && (
            <section className="panel">
              <h2>全部金额变化</h2>
              <p className="muted">原币绝对余额记录；负债减少即还款。选择项目可查看详情并更正。</p>
              <HistoryTable
                rows={positions
                  .flatMap((p) => p.history)
                  .sort((a, b) => b.time.localeCompare(a.time) || b.sequence - a.sequence)}
                open={(id) => {
                  setSelected(id);
                  setPage(positions.find((p) => p.id === id)?.kind || 'account');
                }}
              />
            </section>
          )}
          {page === 'settings' && (
            <>
              <section className="panel">
                <IconLibrary />
              </section>
              <div className="settings-grid">
                <section className="panel">
                  <div className="panel-title">
                    <h2>本位币与个人设置</h2>
                    <button className="text" disabled={busy} onClick={() => void logout()}>
                      <LogOut size={16} />
                      退出登录
                    </button>
                  </div>
                  <p className="muted">
                    账号：{user.username}。切换本位币会重新换算整个历史，原币数据保留。
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void act(
                        () =>
                          api('/settings', 'PATCH', {
                            baseCurrency: f.get('baseCurrency'),
                            showSidebar: f.get('showSidebar') === 'true',
                            idleMinutes: Number(f.get('idleMinutes')),
                          }),
                        '个人设置已保存',
                      );
                    }}
                  >
                    <Field label="左侧菜单栏">
                      <select
                        name="showSidebar"
                        key={String(user.showSidebar)}
                        defaultValue={String(user.showSidebar)}
                      >
                        <option value="true">显示</option>
                        <option value="false">隐藏（顶部仍可切换页面）</option>
                      </select>
                    </Field>
                    <Field label="无操作自动退出（分钟）">
                      <input
                        name="idleMinutes"
                        type="number"
                        min="0"
                        max="1440"
                        required
                        defaultValue={user.idleMinutes}
                        key={user.idleMinutes}
                      />
                    </Field>
                    <p className="muted">
                      0 为关闭；最长 1440 分钟。到时退出登录并清除页面数据，浏览器标签页保留。
                    </p>
                    <Field label="本位币">
                      <select
                        name="baseCurrency"
                        defaultValue={user.baseCurrency}
                        key={user.baseCurrency}
                      >
                        {currencies.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </Field>
                    <button className="primary" disabled={busy}>
                      保存设置
                    </button>
                  </form>
                </section>
                <section className="panel">
                  <h2>每日汇率</h2>
                  {fxStatus && (
                    <p
                      className={fxStatus.state === 'error' ? 'notice warning' : 'muted'}
                      role="status"
                    >
                      {fxStatus.message}
                      {fxStatus.attemptedAt
                        ? ' · ' +
                          new Date(fxStatus.attemptedAt).toLocaleString('zh-CN', {
                            timeZone: 'Asia/Hong_Kong',
                          })
                        : ''}
                    </p>
                  )}
                  <p className="muted">
                    服务器每小时检查当日是否已尝试更新。外部请求固定下载公共汇率表，不发送个人数据。失败保留已有汇率，可稍后重试。
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api('/rates/refresh', 'POST'),
                        '汇率已更新至数据源最新可用日期',
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    立即更新
                  </button>
                  <p className="muted">公共参考汇率可能与银行成交价不同；休市日日期可能滞后。</p>
                </section>
              </div>
              <section className="panel">
                <h2>已保存汇率</h2>
                {rates.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>原币 → 本位币</th>
                          <th>汇率</th>
                          <th>日期</th>
                          <th>来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rates.slice(0, 100).map((r) => (
                          <tr key={r.currency + r.baseCurrency + r.date}>
                            <td>
                              {r.currency} → {r.baseCurrency}
                            </td>
                            <td>{r.rate}</td>
                            <td>{r.date.slice(0, 10)}</td>
                            <td>{r.source === 'manual' ? '历史导入' : 'Frankfurter'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title="没有保存的外币汇率" body="添加外币项目后更新并保存自动汇率。" />
                )}
              </section>
              <section className="panel">
                <h2>清空本账号数据</h2>
                <p className="muted">
                  清除本账号全部账户、资产、债务、历史、私有图标和汇率（包括隐藏项目）；保留登录账号、个人设置和已发布的共享图标。请先下载备份并确认文件已保存。
                </p>
                {clearStep === 0 ? (
                  <a
                    className="secondary"
                    href="/api/backup"
                    download
                    onClick={() => setClearStep(1)}
                  >
                    <Download size={16} />
                    第一步：下载备份
                  </a>
                ) : clearStep === 1 ? (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        const s = await api<{ ready: boolean }>('/backup/clear-status');
                        if (!s.ready) throw new Error('备份尚未完成，请重新下载');
                        setClearStep(2);
                      } catch (e) {
                        report(e);
                      }
                    }}
                  >
                    备份已保存，进入下一步
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const confirmation = new FormData(e.currentTarget).get('confirmation');
                      void act(async () => {
                        await api('/backup/clear', 'POST', { confirmation });
                        setClearStep(0);
                        setSelected(null);
                        setBackup(null);
                        setPreview(null);
                      }, '本账号数据已清空');
                    }}
                  >
                    <Field label="输入“确定清空”以确认">
                      <input name="confirmation" required pattern="确定清空" autoComplete="off" />
                    </Field>
                    <button className="danger" disabled={busy}>
                      清空本账号数据
                    </button>
                  </form>
                )}
                {clearStep > 0 && (
                  <button className="text" onClick={() => setClearStep(0)}>
                    取消清空 / 重新下载
                  </button>
                )}
                <hr />
                <h2>数据备份与恢复</h2>
                <p className="muted">
                  ZIP 内分文件保存可读
                  JSON，包括全部账户、资产、债务、历史、关联、币种、设置、汇率及图标，不限制记录条数；不包含任何认证凭据。备份含个人财务信息，请妥善保管。
                </p>
                <div className="actions">
                  <a
                    className="secondary"
                    href="/api/backup"
                    download={'worthpath-' + today() + '.zip'}
                    onClick={() => setSuccess('备份下载请求已发起，请检查浏览器下载列表')}
                  >
                    <Download size={16} />
                    下载我的数据备份
                  </a>
                  <label className="secondary file-button">
                    <Upload size={16} />
                    选择备份并验证
                    <input
                      type="file"
                      accept=".zip,application/zip,.json,application/json"
                      disabled={busy}
                      onChange={async (e) => {
                        setBackup(null);
                        setPreview(null);
                        setError('');
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const uploadSession = sessionGeneration.current;
                        setBusy(true);
                        try {
                          if (file.size > 512 * 1024 * 1024)
                            throw new Error('ZIP 文件不能超过 512 MB（不限制记录条数）');
                          const form = new FormData();
                          form.append('file', file);
                          const response = await fetch('/api/backup/upload', {
                            method: 'POST',
                            body: form,
                            credentials: 'same-origin',
                          });
                          const result = await response.json();
                          if (!response.ok)
                            throw new ApiError(result.message || 'ZIP 验证失败', response.status);
                          if (uploadSession !== sessionGeneration.current) return;
                          setBackup(result.token);
                          setPreview(result);
                        } catch (err) {
                          if (uploadSession === sessionGeneration.current) report(err);
                        } finally {
                          setBusy(false);
                          e.target.value = '';
                        }
                      }}
                    />
                  </label>
                </div>
                {preview && (
                  <div className="import-preview">
                    <h3>导入预览</h3>
                    <p>
                      {preview.positions} 个项目 · {preview.revisions} 条历史 · {preview.rates}{' '}
                      条汇率
                    </p>
                    <p>
                      备份本位币 {preview.baseCurrency} / 当前本位币 {preview.currentBaseCurrency}
                    </p>
                    <p>{preview.message}</p>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api('/backup/import-file', 'POST', {
                            confirmed: true,
                            token: backup,
                          });
                          setPreview(null);
                          setBackup(null);
                        }, '备份已完整导入')
                      }
                    >
                      确认追加导入
                    </button>
                    <button
                      className="text"
                      onClick={() => {
                        setPreview(null);
                        setBackup(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
          <footer>WorthPath · 记录你的积累，理解你的财富</footer>
        </div>
      </main>
      {modal && (
        <Modal
          title={
            modal.kind === 'reveal'
              ? '验证密码以显示隐藏资产'
              : modal.kind === 'edit'
                ? '编辑项目'
                : modal.kind === 'revision'
                  ? '更新余额 / 估值'
                  : modal.kind === 'correction'
                    ? '更正历史记录'
                    : modal.kind === 'links'
                      ? '管理债务关联'
                      : '新增' + labels[modal.kind]
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                v = Object.fromEntries(f.entries()),
                kind = modal.kind,
                mp = modal.p;
              if (kind === 'reveal') {
                void act(
                  () => api('/auth/reveal', 'POST', { password: f.get('password') }),
                  '隐藏项目已解锁 5 分钟',
                );
              } else if (kind === 'links') {
                void act(
                  () =>
                    api('/positions/' + mp!.id + '/links', 'PUT', {
                      targetIds: f.getAll('targetIds'),
                    }),
                  '关联已更新',
                );
              } else if (kind === 'revision' || kind === 'correction') {
                void act(
                  () =>
                    api(
                      '/positions/' + mp!.id + '/revisions' + (modal.h ? '/' + modal.h.id : ''),
                      modal.h ? 'PUT' : 'POST',
                      v,
                    ),
                  '金额历史已保存，总览已重新计算',
                );
              } else if (kind === 'edit') {
                void act(
                  () =>
                    api('/positions/' + mp!.id, 'PATCH', {
                      ...v,
                      ...(f.has('iconId') ? { iconId: f.get('iconId') || null } : {}),
                      archived: mp!.archived,
                      hidden: f.get('hidden') === 'on',
                    }),
                  '项目资料已保存',
                );
              } else {
                const category = String(v.category),
                  side =
                    kind === 'debt' ||
                    (kind === 'account' && ['credit_card', 'loan'].includes(category))
                      ? 'liability'
                      : 'asset';
                void act(
                  () =>
                    api('/positions', 'POST', {
                      ...v,
                      ...(f.has('iconId') ? { iconId: f.get('iconId') || null } : {}),
                      kind,
                      side,
                      hidden: f.get('hidden') === 'on',
                    }),
                  '项目已添加',
                );
              }
            }}
          >
            {modal.kind === 'reveal' && (
              <Field label="登录密码">
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={72}
                />
              </Field>
            )}
            {['account', 'asset', 'debt', 'edit'].includes(modal.kind) && (
              <>
                <label className="check-line">
                  <input name="hidden" type="checkbox" defaultChecked={modal.p?.hidden} />
                  隐藏此项目（密码验证后可查看和编辑）
                </label>
                {(modal.kind === 'account' || modal.p?.kind === 'account') && (
                  <IconLibrary
                    key={modal.p?.id || 'new-account'}
                    picker
                    initialId={modal.p?.iconId}
                  />
                )}
                <Field label="名称">
                  <input
                    name="name"
                    defaultValue={modal.p?.name}
                    required
                    maxLength={100}
                    autoFocus
                  />
                </Field>
                <Field label="类别">
                  <select
                    name="category"
                    defaultValue={modal.p?.category || categories[modal.kind]?.[0][0]}
                  >
                    {categories[modal.p?.kind || modal.kind].map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                {modal.kind === 'account' && (
                  <p className="muted">信用卡、贷款账户自动计入负债，其余账户计入资产。</p>
                )}
              </>
            )}
            {['account', 'asset', 'debt'].includes(modal.kind) && (
              <Field label="原币币种">
                <select name="currency" defaultValue={user.baseCurrency}>
                  {currencies.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            )}
            {['account', 'asset', 'debt', 'revision', 'correction'].includes(modal.kind) && (
              <Field label={'变更后的绝对金额' + (modal.p ? '（' + modal.p.currency + '）' : '')}>
                <input
                  name="amount"
                  inputMode="decimal"
                  required
                  pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?"
                  defaultValue={modal.h?.after || modal.p?.amount || ''}
                  placeholder="0.00"
                />
              </Field>
            )}
            {['account', 'asset', 'debt', 'revision', 'correction'].includes(modal.kind) && (
              <Field label={'业务时间（北京时间，精确到分钟）'}>
                <input
                  type={'datetime-local'}
                  name="date"
                  required
                  min={'1900-01-01T00:00'}
                  max={nowMinute()}
                  defaultValue={modal.h?.time || nowMinute()}
                />
              </Field>
            )}
            {modal.kind === 'revision' && (
              <>
                <Field label="变更原因">
                  <select
                    name="reason"
                    defaultValue={modal.p?.kind === 'asset' ? 'valuation' : 'balance'}
                  >
                    <option value="balance">余额更新</option>
                    <option value="valuation">估值更新</option>
                    {modal.p?.side === 'liability' && (
                      <option value="repayment">还款（填写还款后欠款）</option>
                    )}
                  </select>
                </Field>
                <p className="muted">
                  填写更新后的余额或剩余欠款，每次保存会新增历史。已有错误记录请在历史中更正。
                </p>
              </>
            )}
            {modal.kind === 'correction' && (
              <p className="notice warning">
                这将修改选中的历史金额并重算后续变化，请确认日期和余额。
              </p>
            )}
            {modal.kind === 'links' ? (
              <div className="link-options">
                {positions.filter((p) => p.kind !== 'debt').length ? (
                  positions
                    .filter((p) => p.kind !== 'debt')
                    .map((p) => (
                      <label key={p.id}>
                        <input
                          type="checkbox"
                          name="targetIds"
                          value={p.id}
                          defaultChecked={modal.p!.outgoing.some((l) => l.targetId === p.id)}
                        />
                        {p.name} · {labels[p.kind]}
                      </label>
                    ))
                ) : (
                  <p>请先创建账户或独立资产。</p>
                )}
              </div>
            ) : (
              modal.kind !== 'reveal' && (
                <Field label="备注">
                  <textarea
                    name="notes"
                    maxLength={2000}
                    rows={3}
                    defaultValue={modal.h?.notes || modal.p?.notes || ''}
                  />
                </Field>
              )
            )}
            {error && (
              <div role="alert" className="notice error">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                {busy ? '正在保存…' : modal.kind === 'correction' ? '确认更正' : '保存'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function HistoryTable({
  rows,
  open,
  correct,
}: {
  rows: History[];
  open?: (id: string) => void;
  correct?: (h: History) => void;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>项目 / 日期</th>
            <th>变更前</th>
            <th>变更后</th>
            <th>变化额</th>
            <th>备注</th>
            {correct && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id}>
              <td>
                {open ? (
                  <button className="text" onClick={() => open(h.positionId)}>
                    {h.name}
                  </button>
                ) : (
                  h.name
                )}
                <small>
                  {displayTime(h.time)} ·{' '}
                  {
                    (
                      {
                        initial: '初始记录',
                        balance: '余额更新',
                        valuation: '估值更新',
                        repayment: '还款',
                        correction: '更正',
                      } as Record<string, string>
                    )[h.reason]
                  }
                </small>
              </td>
              <td>{money(h.before, h.currency)}</td>
              <td>{money(h.after, h.currency)}</td>
              <td>{money(h.delta, h.currency)}</td>
              <td className="notes-cell">{h.notes || '—'}</td>
              {correct && (
                <td>
                  <button className="text" onClick={() => correct(h)}>
                    更正
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="暂无变化记录" body="添加项目或更新金额后，历史会自动保存在这里。" />
  );
}
