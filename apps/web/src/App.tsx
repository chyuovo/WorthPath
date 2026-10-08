import { t as tr, useLocale, LanguagePicker } from './i18n';
import {
  useState,
  useEffect,
  useRef,
  createElement,
  Fragment,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  LayoutDashboard,
  CalendarDays,
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
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  api,
  ApiError,
  currencies,
  money,
  positionAmount,
  accountInputAmount,
  today,
  nowMinute,
  displayTime,
  type User,
  type Position,
  type Overview,
  type History,
  type Rate,
  type Total,
  type PageResult,
} from './api';
import './style.css';
import {
  accountPages,
  overviewPages,
  settingsPages,
  navigationGroup,
  availablePages,
  navigationDestination,
} from './navigation';
import { NetWorthChart } from './NetWorthChart';
import { allOverviewCards, overviewCardLabels } from './overview-cards';
import { useToast } from './Toast';
import { GroupOrderContext } from './GroupOrderContext';
import { GroupOrderList } from './GroupOrderList';
import { orderedGroups, mergeGroupOrder } from './group-order';
import { Calendar } from './Calendar';
import { SchedulePanel } from './SchedulePanel';
import { AgentConnections } from './AgentConnections';
import { AgentAuthorization } from './AgentReview';
import { AgentDrafts } from './AgentDrafts';
import { savedLogin, rememberLogin } from './login-preferences';
import { AdminPanel, FirstPassword } from './AdminPanel';
import { PositionDeletion, deletionLabel } from './PositionDeletion';
import { IconPicker } from './IconPicker';
import { MetalPanel } from './MetalPanel';
import { QuickTransfer } from './QuickTransfer';
import {
  QuickJournal,
  QuickRepayment,
  isPaidForMonth,
  isBookedToday,
  quickAccountVisible,
  canQuickRepay,
  type QuickEntry,
} from './QuickJournal';
import { TransferForm } from './TransferForm';
import { DebtPaymentForm, operationLabel, type DebtOperation } from './DebtPaymentForm';
import type { Transfer } from './api';
import { IconLibrary, iconUrl } from './IconLibrary';
const labels: Record<string, string> = {
  overview: '资产总览',
  account: '账户',
  asset: '独立资产',
  debt: '债务',
  history: '变化记录',
  calendar: '收支日历',
  schedules: '定时计划',
  settings: '设置与备份',
  admin: '管理员后台',
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
    ['cash', '现金'],
    ['property', '房产'],
    ['vehicle', '车辆'],
    ['gold', '贵金属'],
    ['commemorative_coin', '纪念币'],
    ['commemorative_note', '纪念钞'],
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
  tr(categories[p.kind]?.find(([v]) => v === p.category)?.[1] || p.category);
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
    <label className={label === tr('备注') ? 'field note-field' : 'field'}>
      <span>{tr(label)}</span>
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
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="veil native-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="modal">
        <header>
          <h2 className={title.includes(tr('清空本账号数据')) ? 'danger-text' : undefined}>
            {title}
          </h2>
          <button className="icon" aria-label={tr('关闭')} onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </dialog>
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
export default function App() {
  const locale = useLocale();
  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => {
      root.dataset.input = 'pointer';
    };
    const keyboard = () => {
      root.dataset.input = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
      delete root.dataset.input;
    };
  }, []);

  const sessionGeneration = useRef(0),
    loadGeneration = useRef(0);
  const authCheck = useRef<Promise<User> | null>(null);
  const [user, setUser] = useState<User | null>(null),
    [boot, setBoot] = useState(true),
    [page, setPage] = useState(
      new URLSearchParams(location.search).has('agent_authorization') ? 'agent-review' : 'overview',
    ),
    [positions, setPositions] = useState<Position[]>([]),
    [overview, setOverview] = useState<Overview | null>(null),
    [rates, setRates] = useState<Rate[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState<{
      kind: string;
      p?: Position;
      h?: History;
      transfer?: Transfer;
      operation?: DebtOperation;
      quick?: boolean;
      groups?: string[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const [calendarRefresh, setCalendarRefresh] = useState(0);
  const [newAssetCategory, setNewAssetCategory] = useState(categories.asset[0][0]);
  useEffect(() => {
    setNewAssetCategory(categories.asset[0][0]);
  }, [modal?.kind]);
  const [quickTransfer, setQuickTransfer] = useState<{
    sourceId?: string;
    targetId?: string;
  } | null>(null);
  const [quickEntries, setQuickEntries] = useState<QuickEntry[]>([]);
  const [quickMarkMode, setQuickMarkMode] = useState(false);
  const [hideBooked, setHideBooked] = useState(false);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [assetQuickMode, setAssetQuickMode] = useState(false);
  const [assetValueMode, setAssetValueMode] = useState(false);
  const [remember, setRemember] = useState(() => savedLogin().remember);
  const [draftId, setDraftId] = useState(() =>
    new URLSearchParams(location.search).get('agent_operation'),
  );
  const [businessDay, setBusinessDay] = useState(today());
  const [repaymentMonth, setRepaymentMonth] = useState(today().slice(0, 7));
  const quickGeneration = useRef(0);
  useEffect(() => {
    const updateDay = () => {
      setBusinessDay(today());
      setRepaymentMonth(today().slice(0, 7));
    };
    const timer = setInterval(updateDay, 60000);
    window.addEventListener('focus', updateDay);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', updateDay);
    };
  }, []);
  useEffect(() => {
    quickGeneration.current++;
    setQuickEntries([]);
    setQuickMarkMode(false);
    setHideBooked(false);
    setUnpaidOnly(false);
    setAssetQuickMode(false);
  }, [user?.username, user?.revealed]);
  const [quickMode, setQuickMode] = useState(false),
    [accountGroup, setAccountGroup] = useState<string | null>(null);
  useEffect(() => {
    setQuickTransfer(null);
  }, [page, quickMode, selected, user?.revealed]);
  useEffect(() => {
    setQuickTransfer((current) =>
      current &&
      [current.sourceId, current.targetId].some(
        (id) => id && !positions.some((p) => p.id === id && p.kind === 'account' && !p.archived),
      )
        ? null
        : current,
    );
  }, [positions]);
  function toggleQuickMode() {
    quickGeneration.current++;
    if (!quickMode) setQuickEntries([]);
    setQuickMode(!quickMode);
    setQuickMarkMode(false);
    setHideBooked(false);
    setUnpaidOnly(false);
    setQuickTransfer(null);
  }
  function rememberQuick(entry: QuickEntry, generation: number, session: number) {
    if (generation === quickGeneration.current && session === sessionGeneration.current)
      setQuickEntries((rows) => [entry, ...rows]);
  }
  async function saveQuickBalance(
    position: Position,
    data: Record<string, unknown>,
    track: boolean,
  ) {
    const generation = quickGeneration.current,
      session = sessionGeneration.current;
    const result = await api<{ id: string }>(
      '/positions/' + position.id + '/revisions',
      'POST',
      data,
    );
    if (track)
      rememberQuick(
        {
          key: 'balance:' + result.id,
          kind: 'balance',
          id: result.id,
          positionId: position.id,
          title: position.name,
          currency: position.currency,
          before: positionAmount(position),
          after: positionAmount(position, String(data.amount)),
          date: String(data.date),
        },
        generation,
        session,
      );
    return result;
  }
  async function saveQuickMovement(data: unknown, label: string) {
    const value = data as Record<string, string>,
      generation = quickGeneration.current,
      session = sessionGeneration.current;
    const result = await api<{ id: string }>('/transfers', 'POST', data);
    const source = positions.find((p) => p.id === value.sourceId),
      target = positions.find((p) => p.id === value.targetId);
    rememberQuick(
      {
        key: 'transfer:' + result.id,
        kind: 'transfer',
        id: result.id,
        positionId: value.sourceId,
        title: label + ' · ' + (source?.name || '') + ' → ' + (target?.name || ''),
        currency: source?.currency || '',
        amount: value.amount,
        received: value.received,
        fee: value.fee,
        targetCurrency: target?.currency,
        date: value.date,
      },
      generation,
      session,
    );
    return result;
  }
  async function markQuickRepayment(position: Position) {
    const month = today().slice(0, 7),
      previousMonth = position.lastRepaymentMonth ?? null;
    const nextMonth = isPaidForMonth(position, month) ? null : month;
    const generation = quickGeneration.current,
      session = sessionGeneration.current;
    const result = await api<{ updatedAt: string }>(
      '/positions/' + position.id + '/repayment-mark',
      'PATCH',
      { month: nextMonth, expectedMonth: previousMonth, expectedUpdatedAt: position.updatedAt },
    );
    rememberQuick(
      {
        key: 'mark:' + position.id + ':' + Date.now(),
        kind: 'mark',
        id: position.id,
        positionId: position.id,
        title: position.name,
        currency: position.currency,
        date: nowMinute(),
        previousMonth,
        month: nextMonth,
        markUpdatedAt: result.updatedAt,
      },
      generation,
      session,
    );
    return result;
  }
  async function toggleAssetInclusion(position: Position) {
    return api('/positions/' + position.id + '/inclusion', 'PATCH', {
      included: position.included === false,
      expectedIncluded: position.included !== false,
      expectedUpdatedAt: position.updatedAt,
    });
  }
  function undoQuick(entry: QuickEntry) {
    void act(async () => {
      if (entry.kind === 'balance')
        await api('/positions/' + entry.positionId + '/revisions/' + entry.id, 'DELETE');
      else if (entry.kind === 'transfer') await api('/transfers/' + entry.id, 'DELETE');
      else
        await api('/positions/' + entry.positionId + '/repayment-mark', 'PATCH', {
          month: entry.previousMonth ?? null,
          expectedMonth: entry.month ?? null,
          expectedUpdatedAt: entry.markUpdatedAt,
        });
      setQuickEntries((rows) =>
        rows.map((row) => (row.key === entry.key ? { ...row, undone: true } : row)),
      );
    }, tr('记录已撤回，相关余额已更新'));
  }
  function chooseQuickAccount(p: Position) {
    if (busy || loading) return;
    if (p.kind !== 'account' || p.archived) {
      setError(tr('请选择启用的账户'));
      return;
    }
    setQuickTransfer((current) => {
      if (!current) return current;
      if (!current.sourceId) return { sourceId: p.id };
      if (!current.targetId && p.id !== current.sourceId) return { ...current, targetId: p.id };
      return current;
    });
  }
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
  const [clearStep, setClearStep] = useState(0),
    [clearConfirmation, setClearConfirmation] = useState(0);
  useToast(error, 'error');
  useToast(success, 'success');
  useToast(fxStatus?.state === 'error' ? fxStatus.message : '', 'error');
  const [settingsSection, setSettingsSection] = useState(
      new URLSearchParams(location.search).has('agent_authorization') ||
        new URLSearchParams(location.search).has('agent_operation')
        ? 'agent'
        : 'general',
    ),
    [transfers, setTransfers] = useState<Transfer[]>([]);
  const [historyRows, setHistoryRows] = useState<History[]>([]),
    [historyCursor, setHistoryCursor] = useState<string | null>(null),
    [transferCursor, setTransferCursor] = useState<string | null>(null),
    [rangeFrom, setRangeFrom] = useState(
      new Date(+new Date(today()) - 89 * 86400000).toISOString().slice(0, 10),
    ),
    [rangeTo, setRangeTo] = useState(today()),
    [grain, setGrain] = useState('day');
  const [dataVersion, setDataVersion] = useState(0);
  const previousDataVersion = useRef(0);
  const viewKey = [page, selected, rangeFrom, rangeTo, grain, settingsSection, businessDay].join(
    '|',
  );
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const userRef = useRef(user);
  userRef.current = user;
  const activityAt = useRef(0);
  function clearAccount() {
    setQuickMode(false);
    quickGeneration.current++;
    setQuickEntries([]);
    setQuickMarkMode(false);
    setAccountGroup('');
    setClearStep(0);
    setClearConfirmation(0);
    activityAt.current = 0;
    sessionGeneration.current++;
    loadGeneration.current++;
    setUser(null);
    setPositions([]);
    setOverview(null);
    setRates([]);
    setTransfers([]);
    setHistoryRows([]);
    setHistoryCursor(null);
    setTransferCursor(null);
    setFxStatus(null);
    setAccountGroup(null);
    setModal(null);
    setSelected(null);
    setBackup(null);
    setPreview(null);
    setPage('overview');
    setLoading(false);
    setSuccess('');
    setQuickTransfer(null);
  }
  const report = (e: unknown) => {
    setError(e instanceof Error ? e.message : tr('操作失败'));
    if (e instanceof ApiError && e.status === 401) {
      clearAccount();
    }
  };
  async function load(refreshUser = false, rangeOnly = false, runDue = true) {
    const session = sessionGeneration.current,
      request = ++loadGeneration.current,
      view = viewRef.current;
    const active = () =>
      session === sessionGeneration.current &&
      request === loadGeneration.current &&
      view === viewRef.current;
    setLoading(true);
    try {
      const s = refreshUser ? await api<User>('/auth/me') : userRef.current;
      if (!active() || !s) return;
      if (s.mustChangePassword) {
        setUser(s);
        return;
      }
      const visibilityChanged = !!s.revealed !== !!userRef.current?.revealed;
      if (visibilityChanged) rangeOnly = false;
      if (refreshUser) {
        setUser(s);
        setPage((current) => (s.hiddenMenus.includes(current) ? 'settings' : current));
        if (!s.revealed) {
          setPositions((rows) => rows.filter((p) => !p.hidden));
          setHistoryRows([]);
          setTransfers([]);
          if (visibilityChanged) setOverview(null);
        }
      }
      if (page === 'overview' && rangeOnly) {
        const t = await api<PageResult<Total>>(
          '/trend?' + new URLSearchParams({ from: rangeFrom, to: rangeTo, grain }),
        );
        if (!active()) return;
        if (t.revealed !== !!s.revealed) {
          void load(true);
          return;
        }
        setOverview((o) => (o ? { ...o, trend: t.items } : o));
      } else if (page === 'overview') {
        const [o, t, recent] = await Promise.all([
          api<Omit<Overview, 'trend' | 'recent'>>('/overview'),
          api<PageResult<Total>>(
            '/trend?' + new URLSearchParams({ from: rangeFrom, to: rangeTo, grain }),
          ),
          api<PageResult<History>>('/history?limit=20'),
        ]);
        if (!active()) return;
        if ([o.revealed, t.revealed, recent.revealed].some((v) => v !== !!s.revealed)) {
          void load(true);
          return;
        }
        setOverview({ ...o, trend: t.items, recent: recent.items });
      } else if (page === 'schedules') {
        const rows = await api<Position[]>('/positions?kind=account');
        if (active()) setPositions(rows);
      } else if (['account', 'asset', 'debt'].includes(page)) {
        if (page === 'account' && !rangeOnly && runDue && s.role !== 'readonly') {
          const result = await api<{
            executed: number;
            errors: { message: string }[];
            hasMore: boolean;
          }>('/schedules/run', 'POST', {});
          if (!active()) return;
          if (result.errors.length) setError(result.errors[0].message);
          if (result.executed) setSuccess(tr('到期计划已记账') + ` (${result.executed})`);
        }
        const [p, h] = await Promise.all([
          api<Position[]>('/positions?kind=' + page),
          selected
            ? api<PageResult<History>>('/positions/' + selected + '/history?limit=50')
            : Promise.resolve(null),
        ]);
        if (!active()) return;
        setPositions(s.revealed ? p : p.filter((p) => !p.hidden));
        setHistoryRows(h?.items || []);
        setHistoryCursor(h?.nextCursor || null);
      } else if (page === 'history') {
        const [h, t] = await Promise.all([
          api<PageResult<History>>(
            '/history?' + new URLSearchParams({ from: rangeFrom, to: rangeTo, limit: '50' }),
          ),
          api<PageResult<Transfer>>(
            '/transfers?' + new URLSearchParams({ from: rangeFrom, to: rangeTo, limit: '50' }),
          ),
        ]);
        if (!active()) return;
        if ([h.revealed, t.revealed].some((v) => v !== !!s.revealed)) {
          void load(true);
          return;
        }
        setHistoryRows(h.items);
        setHistoryCursor(h.nextCursor);
        setTransfers(t.items);
        setTransferCursor(t.nextCursor);
      } else if (page === 'calendar') {
        setCalendarRefresh((value) => value + 1);
      } else if (page === 'settings') {
        const settings = await api<User & { rates: Rate[]; fxStatus: typeof fxStatus }>(
          '/settings' + (settingsSection === 'rates' ? '?rates=true' : ''),
        );
        if (!active()) return;
        setUser(settings);
        setRates(settings.rates);
        setFxStatus(settings.fxStatus);
      }
    } catch (e) {
      if (active()) report(e);
    } finally {
      if (active()) setLoading(false);
    }
  }
  async function more(kind: 'history' | 'transfers') {
    const session = sessionGeneration.current,
      view = viewRef.current,
      request = loadGeneration.current;
    const cursor = kind === 'history' ? historyCursor : transferCursor;
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const accountId = ['account', 'asset', 'debt'].includes(page) ? selected : null;
      const endpoint =
        kind === 'history' && accountId ? '/positions/' + accountId + '/history' : '/' + kind;
      const query = new URLSearchParams({
        cursor,
        limit: '50',
        ...(!accountId ? { from: rangeFrom, to: rangeTo } : {}),
      });
      const result = await api<PageResult<History | Transfer>>(endpoint + '?' + query);
      if (
        session !== sessionGeneration.current ||
        view !== viewRef.current ||
        request !== loadGeneration.current
      )
        return;
      if (result.revealed !== !!userRef.current?.revealed) {
        void load(true);
        return;
      }
      if (kind === 'history') {
        setHistoryRows((rows) => [...rows, ...(result.items as History[])]);
        setHistoryCursor(result.nextCursor);
      } else {
        setTransfers((rows) => [...rows, ...(result.items as Transfer[])]);
        setTransferCursor(result.nextCursor);
      }
    } catch (e) {
      if (session === sessionGeneration.current && view === viewRef.current) report(e);
    } finally {
      if (session === sessionGeneration.current && view === viewRef.current) setLoading(false);
    }
  }
  const [movementPositions, setMovementPositions] = useState<Position[]>([]);
  const [movementLoading, setMovementLoading] = useState(true);
  useEffect(() => {
    if (!modal || !['transfer', 'debt-payment'].includes(modal.kind)) {
      setMovementPositions([]);
      setMovementLoading(true);
      return;
    }
    let cancelled = false;
    const session = sessionGeneration.current;
    setMovementLoading(true);
    void api<Position[]>('/positions')
      .then((rows) => {
        if (!cancelled && session === sessionGeneration.current) {
          setMovementPositions(rows);
          setMovementLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled && session === sessionGeneration.current) report(error);
      });
    return () => {
      cancelled = true;
    };
  }, [modal]);
  const [linkOptions, setLinkOptions] = useState<Position[]>([]);
  useEffect(() => {
    if (modal?.kind !== 'links') {
      setLinkOptions([]);
      return;
    }
    let cancelled = false;
    const session = sessionGeneration.current;
    void api<Position[]>('/positions')
      .then((rows) => {
        if (!cancelled && session === sessionGeneration.current)
          setLinkOptions(rows.filter((p) => p.kind !== 'debt'));
      })
      .catch((e) => {
        if (!cancelled && session === sessionGeneration.current) report(e);
      });
    return () => {
      cancelled = true;
    };
  }, [modal]);
  const previousView = useRef('');
  const previousBusinessDay = useRef(businessDay);
  useEffect(() => {
    if (!user || user.mustChangePassword) return;
    const dayChanged = previousBusinessDay.current !== businessDay;
    previousBusinessDay.current = businessDay;
    const mutated = previousDataVersion.current !== dataVersion;
    previousDataVersion.current = dataVersion;
    const rangeOnly =
      !mutated &&
      !dayChanged &&
      page === 'overview' &&
      previousView.current.startsWith('overview|') &&
      !!overview;
    previousView.current = viewKey;
    if (!rangeOnly) setOverview(null);
    setHistoryRows([]);
    setHistoryCursor(null);
    setTransfers([]);
    setTransferCursor(null);
    void load(true, rangeOnly, !mutated && !dayChanged);
    return () => {
      loadGeneration.current++;
    };
  }, [viewKey, !!user, user?.mustChangePassword, dataVersion]);
  useEffect(() => {
    const session = sessionGeneration.current;
    authCheck.current ||= api<User>('/auth/me');
    void authCheck.current
      .then((u) => {
        if (session !== sessionGeneration.current) return;
        setUser(u);
        if (u.lastActivity) activityAt.current = +new Date(u.lastActivity);
      })
      .catch((e) => {
        if (session === sessionGeneration.current && !(e instanceof ApiError && e.status === 401))
          report(e);
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
        setError(tr('长时间无操作，已自动退出登录'));
        void api('/auth/logout', 'POST').catch(() => {});
      } else if (!revealExpired && user.revealUntil && Date.now() >= +new Date(user.revealUntil)) {
        revealExpired = true;
        setPositions([]);
        setOverview(null);
        setSelected(null);
        setModal(null);
        setHistoryRows([]);
        setTransfers([]);
        void load(true);
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
      const createdKind =
        modal && ['account', 'asset', 'debt'].includes(modal.kind) ? modal.kind : null;
      setModal(null);
      if (
        createdKind &&
        result &&
        typeof result === 'object' &&
        'id' in result &&
        typeof result.id === 'string'
      ) {
        setPage(createdKind);
        setSelected(result.id);
      }
      setDataVersion((value) => value + 1);
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
      const u = await api<User>('/auth/login', 'POST', {
        username: f.get('username'),
        password: f.get('password'),
      });
      if (session !== sessionGeneration.current) return;
      void rememberLogin(String(f.get('username')), String(f.get('password')), remember);
      const agentReturn = new URLSearchParams(location.search).has('agent_authorization');
      setPage(agentReturn ? 'agent-review' : 'overview');
      if (agentReturn) setSettingsSection('agent');
      setSelected(null);
      setModal(null);
      activityAt.current = Date.now();
      setUser(u);
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
  const p = positions.find((p) => p.id === selected && p.kind === page),
    newAction = (
      <button
        className="primary"
        onClick={() => setModal({ kind: page === 'overview' ? 'account' : page })}
      >
        <Plus size={17} />
        {tr('新增')}
        {page === 'overview' ? tr('账户') : tr(labels[page])}
      </button>
    );
  if (boot) return <div className="splash">{tr('WorthPath · 正在连接你的资产空间…')}</div>;
  if (!user)
    return (
      <div className="auth-layout">
        <div className="auth-language">
          <LanguagePicker />
        </div>
        <section className="auth-story">
          <div className="brand">
            <span>W</span> WorthPath
          </div>
          <div>
            <p className="eyebrow">YOUR WEALTH, IN PERSPECTIVE</p>
            <h1>
              {tr('让每一步积累，')}
              <br />
              {tr('都有清晰的方向。')}
            </h1>
            <p>
              {tr('在一个空间里，连接你的账户、资产与债务。')}
              <br />
              {tr('看见当下，也看见净资产的每一次变化。')}
            </p>
            <div className="story-line">
              <TrendingUp size={32} />
              <span>
                {tr('关注长期积累')}
                <br />
                <small>{tr('从第一份真实资产开始')}</small>
              </span>
            </div>
          </div>
          <small>{tr('个人资产管理 · 多币种 · 历史追踪')}</small>
        </section>
        <section className="auth-form">
          <div>
            <p className="eyebrow">{tr('开始你的资产之路')}</p>
            <h2>{tr('欢迎回来')}</h2>
            <p className="muted">{tr('登录以查看你的资产与负债')}</p>

            <form onSubmit={auth} autoComplete="on">
              <Field label={tr('账号')}>
                <input
                  name="username"
                  defaultValue={savedLogin().username}
                  autoComplete="username"
                  required
                  minLength={3}
                  maxLength={64}
                  placeholder={tr('输入账号（至少 3 个字符）')}
                />
              </Field>
              <Field label={tr('密码')}>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  minLength={1}
                  maxLength={72}
                  placeholder={tr('输入密码')}
                />
              </Field>
              {
                <>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(e) => setRemember(e.target.checked)}
                    />
                    {tr('记住账号密码')}
                  </label>
                  <p className="muted">{tr('密码由浏览器密码管理器保存，下次登录可自动填充。')}</p>
                </>
              }
              <button className="primary full" disabled={busy}>
                {busy ? tr('正在处理…') : tr('登录')}
                <ArrowUpRight size={18} />
              </button>
            </form>
            <p className="muted">{tr('账号由管理员创建，请联系管理员获取账号。')}</p>
            <p className="privacy">
              <ShieldCheck size={16} />
              {tr('个人数据按登录身份隔离')}
            </p>
          </div>
        </section>
      </div>
    );
  if (user.mustChangePassword)
    return <FirstPassword changed={setUser} logout={() => void logout()} report={report} />;
  async function correctHistory(h: History) {
    if (h.reason.startsWith('transfer_') || h.reason.startsWith('loan_')) {
      const session = sessionGeneration.current,
        view = viewRef.current;
      try {
        const transfer = await api<Transfer>('/transfers/revision/' + h.id);
        if (session === sessionGeneration.current && view === viewRef.current)
          setModal({ kind: 'transfer-edit', transfer });
      } catch (e) {
        if (session === sessionGeneration.current && view === viewRef.current) report(e);
      }
      return;
    }
    const session = sessionGeneration.current,
      view = viewRef.current;
    try {
      const p = await api<Position>('/positions/' + h.positionId);
      if (session !== sessionGeneration.current || view !== viewRef.current) return;
      setModal({ kind: 'correction', p, h });
    } catch (e) {
      if (session === sessionGeneration.current && view === viewRef.current) report(e);
    }
  }
  function deleteHistory(h: History) {
    setError('');
    setModal({ kind: 'delete-record', h });
  }
  async function downloadBackup(forClear = false) {
    const session = sessionGeneration.current;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/backup', { credentials: 'same-origin' });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new ApiError(result.message || tr('备份下载失败'), response.status);
      }
      if (!response.headers.get('content-type')?.includes('application/zip'))
        throw new Error(tr('备份文件格式错误'));
      const blob = await response.blob();
      if (!blob.size) throw new Error(tr('备份文件为空'));
      if (session !== sessionGeneration.current) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'worthpath-' + today() + '.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
      setSuccess(tr('备份已生成，请确认文件已保存'));
      if (forClear) setClearStep(1);
    } catch (e) {
      if (session === sessionGeneration.current) report(e);
    } finally {
      if (session === sessionGeneration.current) setBusy(false);
    }
  }
  const agentParams = new URLSearchParams(location.search);
  if (agentParams.has('agent_authorization') || location.pathname === '/agent/authorize') {
    return (
      <main className="agent-review-page">
        <header className="agent-review-header">
          <a href="/">WorthPath</a>
          <span>{user.username}</span>
          <button className="text" disabled={busy} onClick={() => void logout()}>
            退出登录
          </button>
        </header>
        <AgentAuthorization id={agentParams.get('agent_authorization')} />
      </main>
    );
  }
  const nav = [
    ['overview', LayoutDashboard, '总览'],
    ['calendar', CalendarDays, '日历'],
    ['account', Wallet, '账号'],
    ['settings', Settings, '设置'],
  ] as const;
  const hiddenMenus = user.hiddenMenus || [];
  const activeGroup = navigationGroup(page);
  const visibleNav = nav.filter(([key]) => navigationDestination(key, hiddenMenus, user.role));
  const sectionPages =
    activeGroup === 'account'
      ? accountPages
      : activeGroup === 'overview'
        ? overviewPages
        : activeGroup === 'settings'
          ? settingsPages
          : [];
  function navigateTo(next: string) {
    setPage(next);
    setSelected(null);
    setPositions([]);
  }
  const groups = orderedGroups(
    positions.filter((p) => p.kind === 'account').map((p) => p.groupName || ''),
    user.accountGroupOrder,
  );
  const groupRanks = new Map(groups.map((g, index) => [g, index]));
  return createElement(
    GroupOrderContext.Provider,
    { value: user.accountGroupOrder || [] },
    <div className={user.showNotes === false ? 'app notes-hidden' : 'app'}>
      {
        <aside className="sidebar">
          <div className="brand">
            <span>W</span> WorthPath
          </div>
          <p className="nav-caption">{tr('我的资产空间')}</p>
          <nav
            className="primary-nav"
            aria-label={tr('主导航')}
            style={{ gridTemplateColumns: `repeat(${visibleNav.length}, minmax(0, 1fr))` }}
          >
            {visibleNav.map(([key, Icon, label]) => (
              <button
                key={key}
                className={activeGroup === key ? 'active' : ''}
                aria-current={activeGroup === key ? 'page' : undefined}
                onClick={() => {
                  navigateTo(navigationDestination(key, hiddenMenus, user.role)!);
                }}
              >
                <Icon size={19} />
                <span>{tr(label)}</span>
              </button>
            ))}
          </nav>
          <div className="side-bottom">
            <div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{user.username}</strong>
              <small>
                {tr('个人账户 ·')}
                {user.baseCurrency}
              </small>
            </div>
            <button
              className="icon"
              aria-label={tr('退出登录')}
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={18} />
            </button>
          </div>
        </aside>
      }
      <main>
        <header className="topbar">
          <span>
            {tr('个人财务 /')}
            {tr(labels[page])}
          </span>
          <div>
            <LanguagePicker />
            <span className="currency-pill">
              {tr('本位币')}
              {user.baseCurrency}
            </span>
            <button
              className="icon mobile-logout"
              aria-label={tr('退出登录')}
              disabled={busy}
              onClick={() => void logout()}
            >
              <LogOut size={17} />
            </button>
            <button
              className="icon"
              aria-label={tr('刷新数据')}
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <div
          className={
            page === 'account' && quickMode && !selected ? 'content quick-content' : 'content'
          }
        >
          {sectionPages.length > 0 && (
            <nav className="section-nav" aria-label={tr('页面分类')}>
              {availablePages(sectionPages, hiddenMenus, user.role).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-current={page === key ? 'page' : undefined}
                  onClick={() => navigateTo(key)}
                >
                  {tr(labels[key])}
                </button>
              ))}
            </nav>
          )}
          <div className="privacy-toolbar">
            <span>
              {user.revealed
                ? tr('当前包含隐藏资产 · 5 分钟后自动锁定')
                : tr('当前不包含隐藏账户、资产和债务，净资产按此范围计算')}
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                user.revealed
                  ? void act(() => api('/auth/lock', 'POST'), tr('隐藏资产已锁定'))
                  : user.requireHiddenPassword === false
                    ? void act(() => api('/auth/reveal', 'POST', {}), tr('隐藏资产已显示'))
                    : setModal({ kind: 'reveal' })
              }
            >
              {user.revealed ? (
                <EyeOff size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
              {user.revealed
                ? tr('锁定隐藏资产')
                : user.requireHiddenPassword === false
                  ? tr('显示隐藏资产')
                  : tr('显示隐藏资产（验证密码）')}
            </button>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">WORTHPATH / {today()}</p>
              <h1>
                {p?.iconId && (
                  <img className="detail-icon" src={iconUrl(p.iconId)} alt={tr('账户图标')} />
                )}
                {p ? p.name : tr(labels[page])}
              </h1>
              <p className={page === 'calendar' ? 'calendar-page-description' : 'muted'}>
                {page === 'overview'
                  ? tr('你的财富全貌，从这里开始。')
                  : page === 'settings'
                    ? tr('让数据始终可控，让换算清晰可靠。')
                    : tr('保留原币金额，追踪长期变化。')}
              </p>
            </div>
            <div className="actions">
              {user.role !== 'readonly' && page === 'account' && !p && !quickMode && (
                <button className="secondary" onClick={() => setModal({ kind: 'transfer' })}>
                  {tr('转账')}
                </button>
              )}
              {user.role !== 'readonly' &&
                ['overview', 'account', 'asset', 'debt'].includes(page) &&
                !p &&
                !(page === 'account' && quickMode) &&
                newAction}
            </div>
          </div>

          {user.role === 'readonly' && (
            <p className="muted" role="status">
              {tr('当前为只读账号，无法修改业务数据。')}
            </p>
          )}
          {loading && (
            <p role="status" className="muted">
              {tr('正在刷新数据…')}
            </p>
          )}
          {page === 'overview' && overview && (
            <>
              {user.overviewCards?.length === 0 && (
                <section className="panel">
                  <p>{tr('尚未选择总览卡片')}</p>
                  <button
                    className="text"
                    onClick={() => {
                      setPage('settings');
                      setSettingsSection('display');
                    }}
                  >
                    {tr('设置显示卡片')}
                  </button>
                </section>
              )}
              {!!overview.missing.length && (
                <div className="notice warning">
                  {tr('缺少')}
                  {overview.missing.join('、')} {tr('到')}
                  {user.baseCurrency} {tr('的汇率。以下仅展示已能换算的部分，不能作为完整总额。')}
                  <button className="text" onClick={() => setPage('settings')}>
                    {tr('设置汇率')}
                  </button>
                </div>
              )}
              {!!overview.missingValuations?.length && (
                <div className="notice warning">
                  {tr('待估值')}：{overview.missingValuations.map((p) => p.name).join('、')} ·{' '}
                  {tr('缺少报价，当前总额不完整。')}
                </div>
              )}
              <div
                className="metrics"
                hidden={
                  !['assets', 'liabilities', 'net'].some((key) =>
                    (user.overviewCards ?? allOverviewCards).includes(key),
                  )
                }
              >
                {[
                  [tr('总资产'), overview.assets, 'asset'],
                  [tr('总负债'), overview.liabilities, 'debt'],
                  [tr('净资产'), overview.net, 'net'],
                ]
                  .filter(([, , cls]) =>
                    (user.overviewCards ?? allOverviewCards).includes(
                      cls === 'asset' ? 'assets' : cls === 'debt' ? 'liabilities' : cls,
                    ),
                  )
                  .map(([title, value, cls]) => (
                    <section className={'metric ' + cls} key={title}>
                      <div>
                        <span>
                          {title}
                          {!overview.complete ? tr('（部分）') : ''}
                        </span>
                        <ArrowUpRight size={18} />
                      </div>
                      <strong
                        className={
                          cls === 'debt' || value.startsWith('-') ? 'danger-text' : 'income-text'
                        }
                      >
                        {money(value, user.baseCurrency)}
                      </strong>
                      <small>
                        {title === tr('净资产')
                          ? tr('总资产 − 总负债')
                          : title === tr('总资产')
                            ? tr('账户资产 + 独立资产')
                            : tr('负债账户 + 独立债务')}
                      </small>
                    </section>
                  ))}
              </div>
              <div
                className={
                  'dashboard-grid' +
                  (!['trend', 'composition'].every((key) =>
                    (user.overviewCards ?? allOverviewCards).includes(key),
                  )
                    ? ' single-card'
                    : '')
                }
                hidden={
                  !['trend', 'composition'].some((key) =>
                    (user.overviewCards ?? allOverviewCards).includes(key),
                  )
                }
              >
                <section
                  className="panel"
                  hidden={!(user.overviewCards ?? allOverviewCards).includes('trend')}
                >
                  <div className="panel-title">
                    <h2>{tr('净资产轨迹')}</h2>
                    <span className="badge">{tr('按业务日期')}</span>
                  </div>
                  <div className="actions overview-filters">
                    <label>
                      {tr('开始')}
                      <input
                        type="date"
                        value={rangeFrom}
                        max={rangeTo}
                        onChange={(e) => setRangeFrom(e.target.value)}
                      />
                    </label>
                    <label>
                      {tr('结束')}
                      <input
                        type="date"
                        value={rangeTo}
                        min={rangeFrom}
                        max={today()}
                        onChange={(e) => setRangeTo(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label={tr('统计粒度')}
                      value={grain}
                      onChange={(e) => setGrain(e.target.value)}
                    >
                      <option value="day">{tr('日（最多366天）')}</option>
                      <option value="week">{tr('周（最多3年）')}</option>
                      <option value="month">{tr('月（最多10年）')}</option>
                    </select>
                  </div>
                  <p className="muted">
                    {tr(
                      '默认最近90天；周一至周日及自然月取期末余额，变化归因累计区间内每日变化，首尾不足周期按实际范围。',
                    )}
                  </p>
                  <NetWorthChart rows={overview.trend} base={user.baseCurrency} />
                  <p className="muted">
                    {tr('按当时可用汇率重放；更正历史后重新计算。归档项目仍计入。')}
                  </p>
                </section>
                <section
                  className="panel"
                  hidden={!(user.overviewCards ?? allOverviewCards).includes('composition')}
                >
                  <h2>{tr('资产与负债组成')}</h2>
                  {overview.items.length ? (
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
                          {tr(labels[k])}
                          <small>
                            {overview.items.filter((p) => p.included && p.kind === k).length}{' '}
                            {tr('个项目')}
                          </small>
                        </span>
                        <ArrowUpRight size={18} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      title={tr('从一个账户开始')}
                      body={tr('添加银行、现金或投资账户，建立你的资产全貌。')}
                      action={newAction}
                    />
                  )}
                  <p className="privacy">
                    <ShieldCheck size={15} />
                    {tr('关联关系不会重复计入总额')}
                  </p>
                </section>
              </div>
              <section
                className="panel"
                hidden={!(user.overviewCards ?? allOverviewCards).includes('recent')}
              >
                <div className="panel-title">
                  <h2>{tr('最近变化')}</h2>
                  <button className="text" onClick={() => setPage('history')}>
                    {tr('查看全部 →')}
                  </button>
                </div>
                <HistoryTable
                  rows={overview.recent.slice(0, 6)}
                  open={(id) => {
                    setSelected(id);
                    setPage(overview.recent.find((h) => h.positionId === id)?.kind || 'account');
                  }}
                />
              </section>
              <div className="fx-caption">
                {tr('本位币')}
                {user.baseCurrency} {tr('· 汇率日期：')}
                {[
                  ...new Set(
                    overview.items
                      .filter((i) => i.currency !== user.baseCurrency && i.rateDate)
                      .map((i) => i.rateDate),
                  ),
                ].join(' / ') || tr('尚无外币汇率')}{' '}
                {tr('· 每日尝试更新，失败保留已有数据；旧日期汇率可能产生换算偏差。')}
              </div>
              {(user.overviewCards ?? allOverviewCards).includes('attribution') &&
                overview.trend.length > 1 && (
                  <details className="panel attribution">
                    <summary>{tr('变化归因')}</summary>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{tr('日期')}</th>
                            <th>{tr('余额 / 估值变化')}</th>
                            <th>{tr('汇率变化')}</th>
                            <th>{tr('净资产')}</th>
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
                              <td>
                                {r.complete ? money(r.net, user.baseCurrency) : tr('汇率不完整')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
            </>
          )}
          {['account', 'asset', 'debt'].includes(page) &&
            (p ? (
              <>
                <button className="text back" onClick={() => setSelected(null)}>
                  <ArrowLeft size={16} />
                  {tr('返回列表')}
                </button>
                <section className="panel detail-summary">
                  <div>
                    <span className="badge">
                      {categoryLabel(p)} ·{' '}
                      {p.kind === 'debt'
                        ? tr(p.side === 'asset' ? '借款（待收）' : '欠款（待还）')
                        : p.side === 'asset'
                          ? tr('资产')
                          : tr(
                              p.kind === 'account' && p.amount.startsWith('-')
                                ? '溢缴存款'
                                : '负债',
                            )}
                      {p.archived ? tr(' · 已归档') : ''}
                    </span>
                    <h2
                      className={positionAmount(p).startsWith('-') ? 'danger-text' : 'income-text'}
                    >
                      {p.valuationAvailable === false
                        ? tr('待估值')
                        : money(positionAmount(p), p.currency)}
                      {p.metalGrams && <small> · {p.metalGrams} g</small>}
                    </h2>
                    {p.hidden && <span className="badge">{tr('隐藏资产')}</span>}
                    <p className="muted" hidden={p.currency === user.baseCurrency}>
                      {tr('本位币：')}
                      {p.converted !== null
                        ? money(positionAmount(p, p.converted || '0'), user.baseCurrency)
                        : tr(p.valuationAvailable === false ? '待估值' : '缺少汇率')}
                    </p>
                    <p className="notes-display">{p.notes || tr('暂无备注')}</p>
                    {(p.included === false ||
                      (p.kind === 'asset' && user.includeIndependentAssets === false)) && (
                      <span className="badge">{tr('不计入总览')}</span>
                    )}
                    <small>{tr('币种和资产负债属性创建后固定。归档项目仍计入总览。')}</small>
                  </div>
                  <div className="actions">
                    {p.kind === 'account' && !p.archived && (
                      <>
                        <button
                          className="primary"
                          onClick={() => setModal({ kind: 'transfer', p })}
                        >
                          {tr('转账')}
                        </button>
                        <button
                          hidden={p.side !== 'asset'}
                          className="secondary"
                          onClick={() => setModal({ kind: 'debt-payment', p })}
                        >
                          {tr('收款 / 还款')}
                        </button>
                      </>
                    )}
                    {p.kind === 'debt' && !p.archived && (
                      <>
                        <button
                          className="primary"
                          onClick={() =>
                            setModal({
                              kind: 'debt-payment',
                              p,
                              operation: p.side === 'asset' ? 'collect' : 'repay',
                            })
                          }
                        >
                          {operationLabel(p.side === 'asset' ? 'collect' : 'repay')}
                        </button>
                      </>
                    )}
                    <button
                      className="secondary danger-text"
                      disabled={busy}
                      onClick={() => setModal({ kind: 'delete-position', p })}
                    >
                      删除{deletionLabel(p)}
                    </button>
                    <button className="secondary" onClick={() => setModal({ kind: 'edit', p })}>
                      {tr('编辑资料')}
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
                              groupName: p.groupName,
                              notes: p.notes,
                              archived: !p.archived,
                              hidden: p.hidden,
                            }),
                          p.archived ? tr('项目已恢复') : tr('项目已归档'),
                        )
                      }
                    >
                      {p.archived ? tr('恢复项目') : tr('归档项目')}
                    </button>
                    <button
                      className="primary"
                      disabled={p.archived}
                      onClick={() => setModal({ kind: 'revision', p })}
                    >
                      {tr('更新')}
                      {p.kind === 'asset' ? tr('估值') : tr('余额')}
                    </button>
                  </div>
                </section>
                {p.kind === 'asset' && p.category === 'gold' && (
                  <MetalPanel position={p} refresh={() => load(false, true)} />
                )}
                {p.kind === 'debt' && (
                  <section className="panel">
                    <div className="panel-title">
                      <h2>{tr('关联资产与账户')}</h2>
                      <button className="text" onClick={() => setModal({ kind: 'links', p })}>
                        {tr('管理关联')}
                      </button>
                    </div>
                    <p className="muted">{tr('只展示关系，不改变资产或债务的统计。')}</p>
                    {p.outgoing.length ? (
                      p.outgoing.map((l) => (
                        <button
                          className="secondary"
                          key={l.targetId}
                          onClick={() => {
                            setSelected(l.targetId);
                            setPage(l.target.kind);
                          }}
                        >
                          {l.target.name}
                        </button>
                      ))
                    ) : (
                      <p>{tr('尚未关联')}</p>
                    )}
                  </section>
                )}
                <section className="panel">
                  <h2>{tr('余额与估值历史')}</h2>
                  <p className="muted">
                    {tr(
                      '每次更新保留独立历史，同日按记录顺序展示。错误记录可单独更正，后续变化自动重算。',
                    )}
                  </p>
                  <HistoryTable
                    rows={historyRows}
                    correct={p.archived ? undefined : (h) => void correctHistory(h)}
                    remove={p.archived ? undefined : deleteHistory}
                    busy={busy}
                  />
                  {historyCursor && (
                    <button disabled={loading} onClick={() => void more('history')}>
                      {tr('加载更早记录')}
                    </button>
                  )}
                </section>
              </>
            ) : (
              <section
                className={page === 'account' && quickMode ? 'panel quick-account-panel' : 'panel'}
              >
                {page === 'account' && (
                  <>
                    <div
                      className={
                        'actions account-tools ' +
                        (quickMode ? 'account-tools-quick' : 'account-tools-browse')
                      }
                    >
                      <button
                        className={quickMode ? 'primary' : 'secondary'}
                        aria-pressed={quickMode}
                        disabled={busy}
                        onClick={toggleQuickMode}
                      >
                        {tr(quickMode ? '退出快速记账' : '快速记账')}
                      </button>
                      {quickMode && (
                        <button
                          className={quickMarkMode ? 'primary' : 'secondary'}
                          disabled={busy}
                          aria-pressed={quickMarkMode}
                          onClick={() => {
                            setQuickMarkMode(!quickMarkMode);
                            setQuickTransfer(null);
                          }}
                        >
                          {tr(quickMarkMode ? '结束还款标记' : '标记本月还款')}
                        </button>
                      )}
                      {quickMode && (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              busy ||
                              positions.filter((p) => p.kind === 'account' && !p.archived).length <
                                2
                            }
                            onClick={() => {
                              setQuickMarkMode(false);
                              setHideBooked(false);
                              setUnpaidOnly(false);
                              setQuickTransfer({});
                            }}
                          >
                            {tr('转账')}
                          </button>
                          <button
                            className="secondary"
                            aria-pressed={unpaidOnly}
                            disabled={busy}
                            onClick={() => {
                              setUnpaidOnly(!unpaidOnly);
                              setQuickTransfer(null);
                            }}
                          >
                            {unpaidOnly ? (
                              <Eye size={17} aria-hidden="true" />
                            ) : (
                              <EyeOff size={17} aria-hidden="true" />
                            )}
                            {tr(unpaidOnly ? '显示全部账户' : '仅看本月未还款')}
                          </button>
                          <button
                            className="secondary"
                            aria-pressed={hideBooked}
                            disabled={busy}
                            onClick={() => {
                              setHideBooked(!hideBooked);
                              setQuickTransfer(null);
                            }}
                          >
                            {hideBooked ? (
                              <Eye size={17} aria-hidden="true" />
                            ) : (
                              <EyeOff size={17} aria-hidden="true" />
                            )}
                            {tr(hideBooked ? '显示当天有记录' : '隐藏当天有记录')}
                          </button>
                        </>
                      )}
                      <select
                        aria-label={tr('账户分组')}
                        value={accountGroup === null ? 'all' : JSON.stringify(accountGroup)}
                        onChange={(e) =>
                          setAccountGroup(
                            e.target.value === 'all' ? null : JSON.parse(e.target.value),
                          )
                        }
                      >
                        <option value="all">{tr('全部账户')}</option>
                        {groups.map((g) => (
                          <option key={g} value={JSON.stringify(g)}>
                            {g || tr('未分组')}
                          </option>
                        ))}
                      </select>
                      <button
                        className="secondary"
                        hidden={quickMode}
                        disabled={busy || groups.length < 2}
                        onClick={() => setModal({ kind: 'group-order', groups: [...groups] })}
                      >
                        {tr('分组排序')}
                      </button>
                    </div>
                    {quickMode && (
                      <p className="muted">
                        {tr(
                          quickMarkMode
                            ? '点击欠款账户卡片，标记或取消本月已还款。'
                            : quickTransfer !== null
                              ? '快速转账中：依次点击转出和转入账户卡片。'
                              : '点击账户卡片，直接填写当前余额。',
                        )}
                      </p>
                    )}
                  </>
                )}
                {page === 'asset' && (
                  <>
                    <div className="actions account-tools">
                      <button
                        className={assetQuickMode ? 'primary' : 'secondary'}
                        disabled={busy}
                        aria-pressed={assetQuickMode}
                        onClick={() => {
                          setAssetQuickMode(!assetQuickMode);
                          setAssetValueMode(false);
                        }}
                      >
                        {tr(assetQuickMode ? '结束统计设置' : '快速设置计入总资产')}
                      </button>
                      <button
                        className={assetValueMode ? 'primary' : 'secondary'}
                        disabled={busy}
                        aria-pressed={assetValueMode}
                        onClick={() => {
                          setAssetValueMode(!assetValueMode);
                          setAssetQuickMode(false);
                        }}
                      >
                        {tr(assetValueMode ? '结束快速估值' : '快速设置估值')}
                      </button>
                    </div>
                    {assetValueMode && (
                      <p className="muted">
                        {tr('点击资产卡片填写最新估值；贵金属按报价自动估值。')}
                      </p>
                    )}
                    {assetQuickMode && (
                      <p className="muted">{tr('点击资产卡片，切换是否计入总资产。')}</p>
                    )}
                    {assetQuickMode && user.includeIndependentAssets === false && (
                      <p className="muted">
                        {tr('独立资产总开关已关闭；单项设置已保存，开启总开关后生效。')}
                      </p>
                    )}
                  </>
                )}
                {page === 'account' &&
                  quickMode &&
                  positions.some((p) => p.kind === 'account') &&
                  !positions.some(
                    (p) =>
                      p.kind === 'account' &&
                      (accountGroup === null || (p.groupName || '') === accountGroup) &&
                      quickAccountVisible(p, repaymentMonth, businessDay, unpaidOnly, hideBooked),
                  ) && (
                    <p className="muted" role="status">
                      {tr('当前筛选下没有账户，可切换筛选查看其他账户。')}
                    </p>
                  )}
                {positions.some((p) => p.kind === page) ? (
                  <div
                    className={
                      'position-grid' +
                      (page === 'account' && quickMode ? ' quick-dense-grid' : '') +
                      (quickTransfer !== null && page === 'account' ? ' quick-transfer-select' : '')
                    }
                  >
                    {positions
                      .filter(
                        (p) =>
                          p.kind === page &&
                          (page !== 'account' ||
                            accountGroup === null ||
                            (p.groupName || '') === accountGroup) &&
                          (page !== 'account' ||
                            !quickMode ||
                            quickAccountVisible(
                              p,
                              repaymentMonth,
                              businessDay,
                              unpaidOnly,
                              hideBooked,
                            )),
                      )
                      .sort((a, b) =>
                        page === 'account'
                          ? (groupRanks.get(a.groupName || '') || 0) -
                            (groupRanks.get(b.groupName || '') || 0)
                          : 0,
                      )
                      .map((p, index, rows) => (
                        <Fragment key={p.id}>
                          {page === 'account' &&
                            accountGroup === null &&
                            (index === 0 ||
                              (rows[index - 1].groupName || '') !== (p.groupName || '')) && (
                              <h3 className="account-group-title">{p.groupName || tr('未分组')}</h3>
                            )}
                          <button
                            className={
                              'position-card' +
                              (p.name.length > 40 ||
                              money(positionAmount(p), p.currency).length > 18
                                ? ' position-wide'
                                : '') +
                              (quickTransfer?.sourceId === p.id
                                ? ' quick-source'
                                : quickTransfer?.targetId === p.id
                                  ? ' quick-target'
                                  : '')
                            }
                            aria-pressed={
                              quickTransfer
                                ? quickTransfer.sourceId === p.id || quickTransfer.targetId === p.id
                                : undefined
                            }
                            disabled={
                              busy ||
                              (page === 'asset' &&
                                assetValueMode &&
                                (p.archived || p.category === 'gold')) ||
                              (!!quickTransfer && p.archived) ||
                              (quickMode && quickMarkMode && (p.side !== 'liability' || p.archived))
                            }
                            key={p.id}
                            onClick={() =>
                              page === 'asset' && assetValueMode
                                ? setModal({ kind: 'revision', p })
                                : page === 'asset' && assetQuickMode
                                  ? void act(() => toggleAssetInclusion(p), tr('统计设置已保存'))
                                  : quickMode && quickMarkMode && page === 'account'
                                    ? p.kind === 'account' && p.side === 'liability' && !p.archived
                                      ? void act(() => markQuickRepayment(p), tr('还款标记已保存'))
                                      : undefined
                                    : quickTransfer !== null && page === 'account' && quickMode
                                      ? chooseQuickAccount(p)
                                      : page === 'account' && quickMode && !p.archived
                                        ? setModal({ kind: 'revision', p, quick: true })
                                        : setSelected(p.id)
                            }
                          >
                            <div>
                              <span className="position-icon">
                                {p.iconId ? (
                                  <img src={iconUrl(p.iconId)} alt={tr('账户图标')} />
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
                            {isPaidForMonth(p, repaymentMonth) && (
                              <span className="badge repayment-paid">{tr('本月已还款')}</span>
                            )}
                            {quickMode && page === 'account' && isBookedToday(p, businessDay) && (
                              <span className="badge repayment-paid">{tr('当天有记账记录')}</span>
                            )}
                            {assetQuickMode && page === 'asset' && p.included !== false && (
                              <span className="badge repayment-paid">{tr('计入总资产')}</span>
                            )}
                            {(p.included === false ||
                              (p.kind === 'asset' && user.includeIndependentAssets === false)) && (
                              <span className="badge">{tr('不计入总览')}</span>
                            )}
                            <p className="position-secondary">
                              {categoryLabel(p)} ·{' '}
                              {p.kind === 'debt'
                                ? tr(p.side === 'asset' ? '借款（待收）' : '欠款（待还）')
                                : p.side === 'asset'
                                  ? tr('资产')
                                  : tr(
                                      p.kind === 'account' && p.amount.startsWith('-')
                                        ? '溢缴存款'
                                        : '负债',
                                    )}
                              {p.archived ? tr(' · 已归档') : ''}
                            </p>
                            <strong
                              className={
                                positionAmount(p).startsWith('-') ? 'danger-text' : 'income-text'
                              }
                            >
                              {p.valuationAvailable === false
                                ? tr('待估值')
                                : money(positionAmount(p), p.currency)}
                              {p.metalGrams && <small> · {p.metalGrams} g</small>}
                            </strong>
                            <small
                              className="position-secondary"
                              hidden={p.currency === user.baseCurrency}
                            >
                              {tr('折合')}{' '}
                              {p.converted === null
                                ? tr(p.valuationAvailable === false ? '待估值' : '缺少汇率')
                                : money(positionAmount(p, p.converted || '0'), user.baseCurrency)}
                            </small>
                          </button>
                        </Fragment>
                      ))}
                  </div>
                ) : (
                  <Empty
                    title={tr('还没有') + tr(labels[page])}
                    body={tr('添加真实数据后，这里将展示原币余额和历史变化。')}
                    action={newAction}
                  />
                )}
              </section>
            ))}
          {page === 'account' && quickMode && !selected && (
            <aside className="quick-session-panel panel" aria-label={tr('快速记账操作')}>
              {quickTransfer !== null && (
                <section className="quick-transfer-card">
                  <div className="panel-title">
                    <h2>{tr('快速转账')}</h2>
                    <button
                      type="button"
                      className="icon"
                      aria-label={tr('关闭快速转账')}
                      disabled={busy}
                      onClick={() => setQuickTransfer(null)}
                    >
                      ×
                    </button>
                  </div>
                  {!quickTransfer.sourceId ? (
                    <p>{tr('点击账户卡片选择转出账户')}</p>
                  ) : !quickTransfer.targetId ? (
                    <>
                      <p>
                        {tr('转出账户：')}
                        {positions.find((p) => p.id === quickTransfer.sourceId)?.name}
                      </p>
                      <p>{tr('点击另一张账户卡片选择转入账户')}</p>
                      <button type="button" className="text" onClick={() => setQuickTransfer({})}>
                        {tr('重新选择')}
                      </button>
                    </>
                  ) : (
                    positions.some((p) => p.id === quickTransfer.sourceId) &&
                    positions.some((p) => p.id === quickTransfer.targetId) && (
                      <QuickTransfer
                        key={quickTransfer.sourceId + quickTransfer.targetId}
                        source={positions.find((p) => p.id === quickTransfer.sourceId)!}
                        target={positions.find((p) => p.id === quickTransfer.targetId)!}
                        busy={busy}
                        changeSource={() => setQuickTransfer({})}
                        changeTarget={() => setQuickTransfer({ sourceId: quickTransfer.sourceId })}
                        submit={(data) =>
                          void act(async () => {
                            const result = await saveQuickMovement(data, tr('转账'));
                            setQuickTransfer(null);
                            return result;
                          }, tr('转账已完成'))
                        }
                      />
                    )
                  )}
                </section>
              )}
              <QuickJournal entries={quickEntries} busy={busy} undo={undoQuick} />
            </aside>
          )}
          {page === 'history' && (
            <>
              <section className="panel">
                <div className="actions">
                  <label>
                    {tr('开始')}
                    <input
                      type="date"
                      value={rangeFrom}
                      max={rangeTo}
                      onChange={(e) => setRangeFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    {tr('结束')}
                    <input
                      type="date"
                      value={rangeTo}
                      min={rangeFrom}
                      max={today()}
                      onChange={(e) => setRangeTo(e.target.value)}
                    />
                  </label>
                </div>
                <h2>{tr('资金往来')}</h2>
                {transfers.length ? (
                  <div className="transfer-list">
                    {transfers.map((t) => (
                      <article key={t.id}>
                        <div>
                          <strong>
                            {operationLabel(t.operation || 'transfer')} ·
                            <button
                              className="text"
                              onClick={() => {
                                setSelected(t.sourceId);
                                setPage(t.source.kind);
                              }}
                            >
                              {t.source.name}
                            </button>
                            {' ↔ '}
                            <button
                              className="text"
                              onClick={() => {
                                setSelected(t.targetId);
                                setPage(t.target.kind);
                              }}
                            >
                              {t.target.name}
                            </button>
                          </strong>
                          <small>{displayTime(t.date)}</small>
                        </div>
                        <p>
                          {money(t.amount, t.sourceCurrency)} →{' '}
                          {money(t.received, t.targetCurrency)} {tr('· 手续费')}
                          {money(t.fee, t.sourceCurrency)}
                        </p>
                        {t.notes && <p className="muted notes-display">{t.notes}</p>}
                        <div className="actions record-actions">
                          <button
                            className="text"
                            disabled={busy}
                            onClick={() => setModal({ kind: 'transfer-edit', transfer: t })}
                          >
                            {tr('修改')}
                          </button>
                          <button
                            className="text danger-text"
                            disabled={busy}
                            onClick={() => {
                              setError('');
                              setModal({ kind: 'delete-record', transfer: t });
                            }}
                          >
                            {tr('删除')}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="muted">{tr('暂无转账记录。')}</p>
                )}
                {transferCursor && (
                  <button disabled={loading} onClick={() => void more('transfers')}>
                    {tr('加载更早转账')}
                  </button>
                )}
                <h2>{tr('全部金额变化')}</h2>
                <p className="muted">
                  {tr('原币绝对余额记录；负债减少即还款。选择项目可查看详情并更正。')}
                </p>
                <HistoryTable
                  rows={historyRows}
                  correct={(h) => void correctHistory(h)}
                  remove={deleteHistory}
                  busy={busy}
                  open={(id) => {
                    setSelected(id);
                    setPage(historyRows.find((h) => h.positionId === id)?.kind || 'account');
                  }}
                />
                {historyCursor && (
                  <button disabled={loading} onClick={() => void more('history')}>
                    {tr('加载更早记录')}
                  </button>
                )}
              </section>
            </>
          )}
          {page === 'schedules' && (
            <section className="panel">
              <SchedulePanel
                accounts={positions.filter((p) => p.kind === 'account' && !p.archived)}
                refresh={() => load(false, true)}
              />
            </section>
          )}
          {page === 'calendar' && (
            <Calendar revealed={!!user.revealed} refreshVersion={calendarRefresh} />
          )}
          {page === 'admin' && user.role === 'admin' && <AdminPanel user={user} report={report} />}
          {page === 'settings' && (
            <>
              <label className="settings-category">
                <span>{tr('设置分类')}</span>
                <select
                  value={settingsSection}
                  onChange={(event) => setSettingsSection(event.target.value)}
                >
                  {Object.entries({
                    general: '常规设置',
                    agent: '连接 Agent',
                    display: '显示与菜单',
                    privacy: '登录与隐私',
                    security: '账号与密码',
                    icons: '图标库',
                    rates: '每日汇率',
                    backup: '备份与恢复',
                    clear: '清空本账号数据',
                  }).map(([key, label]) => (
                    <option key={key} value={key}>
                      {tr(label)}
                    </option>
                  ))}
                </select>
              </label>
              {settingsSection === 'icons' && (
                <section className="panel">
                  <IconLibrary />
                </section>
              )}
              {settingsSection === 'agent' && <AgentConnections changed={() => void load()} />}
              {settingsSection === 'security' && (
                <section className="panel">
                  <h2>{tr('账号与密码')}</h2>
                  <p className="muted">{tr('修改后其他登录会话将退出，当前会话保持登录。')}</p>
                  <form
                    key={user.username}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget,
                        f = new FormData(form);
                      const username = String(f.get('username')).trim(),
                        newPassword = String(f.get('newPassword'));
                      if (newPassword !== String(f.get('confirmPassword'))) {
                        setError(tr('两次输入的新密码不一致'));
                        return;
                      }
                      void act(async () => {
                        const result = await api('/auth/credentials', 'PATCH', {
                          currentPassword: f.get('currentPassword'),
                          ...(username !== user.username ? { username } : {}),
                          ...(newPassword ? { newPassword } : {}),
                        });
                        form.reset();
                        return result;
                      }, tr('账号与密码已更新'));
                    }}
                  >
                    <Field label={tr('账号')}>
                      <input
                        name="username"
                        autoComplete="username"
                        required
                        minLength={3}
                        maxLength={64}
                        defaultValue={user.username}
                      />
                    </Field>
                    <Field label={tr('当前密码')}>
                      <input
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        required
                        minLength={10}
                        maxLength={72}
                      />
                    </Field>
                    <Field label={tr('新密码（不修改请留空）')}>
                      <input
                        name="newPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={10}
                        maxLength={72}
                      />
                    </Field>
                    <Field label={tr('确认新密码')}>
                      <input
                        name="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={10}
                        maxLength={72}
                      />
                    </Field>
                    <button className="primary" disabled={busy}>
                      {tr('保存修改')}
                    </button>
                  </form>
                </section>
              )}
              <div className="settings-grid">
                <section className="panel" hidden={settingsSection !== 'general'}>
                  <div className="panel-title">
                    <h2>{tr('常规设置')}</h2>
                    <button className="text" disabled={busy} onClick={() => void logout()}>
                      <LogOut size={16} />
                      {tr('退出登录')}
                    </button>
                  </div>
                  <p className="muted">
                    {tr('账号：')}
                    {user.username}
                    {tr('。切换本位币会重新换算整个历史，原币数据保留。')}
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void act(
                        () => api('/settings', 'PATCH', { baseCurrency: f.get('baseCurrency') }),
                        tr('设置已保存'),
                      );
                    }}
                  >
                    <Field label={tr('本位币')}>
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
                      {tr('保存设置')}
                    </button>
                  </form>
                </section>
                <section className="panel" hidden={settingsSection !== 'display'}>
                  <h2>{tr('显示与菜单')}</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void act(
                        () =>
                          api('/settings', 'PATCH', {
                            hiddenMenus: [
                              'overview',
                              'account',
                              'asset',
                              'debt',
                              'history',
                              'calendar',
                              'schedules',
                            ].filter((key) => !f.has('menu_' + key)),
                            showNotes: f.has('showNotes'),
                            includeIndependentAssets: f.has('includeIndependentAssets'),
                            overviewCards: allOverviewCards.filter((key) => f.has('card_' + key)),
                          }),
                        tr('设置已保存'),
                      );
                    }}
                  >
                    <label className="switch-row">
                      <span>{tr('独立资产计入总览')}</span>
                      <input
                        type="checkbox"
                        role="switch"
                        name="includeIndependentAssets"
                        defaultChecked={user.includeIndependentAssets !== false}
                        key={String(user.includeIndependentAssets)}
                      />
                    </label>
                    <p className="muted">
                      {tr('关闭后，独立资产不参与总额和净资产轨迹，资料与历史仍保留。')}
                    </p>
                    <h3>{tr('导航菜单')}</h3>
                    <p className="muted">
                      {tr('选择需要显示的菜单项。设置入口始终保留，隐藏仅影响导航，不删除数据。')}
                    </p>
                    <div className="menu-preferences">
                      {[
                        'overview',
                        'account',
                        'asset',
                        'debt',
                        'history',
                        'calendar',
                        'schedules',
                      ].map((key) => (
                        <label key={key} className="switch-row">
                          <span>{tr(labels[key])}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={tr(labels[key]) + tr('显示')}
                            name={'menu_' + key}
                            key={key + String(user.hiddenMenus)}
                            defaultChecked={!(user.hiddenMenus || []).includes(key)}
                          />
                          <span className="switch-state" aria-hidden="true">
                            {tr('显示')}
                          </span>
                        </label>
                      ))}
                    </div>
                    <label className="switch-row">
                      <span>{tr('显示备注')}</span>
                      <input
                        type="checkbox"
                        role="switch"
                        name="showNotes"
                        aria-label={tr('显示备注')}
                        key={String(user.showNotes)}
                        defaultChecked={user.showNotes !== false}
                      />
                      <span className="switch-state" aria-hidden="true">
                        {tr('显示')}
                      </span>
                    </label>
                    <p className="muted">
                      {tr('关闭后隐藏列表、详情及编辑表单中的备注，已有备注仍会保留在备份中。')}
                    </p>

                    <h3>{tr('总览显示卡片')}</h3>
                    <p className="muted">
                      {tr('选择资产总览需要显示的卡片，数据和记录仍会保留。')}
                    </p>
                    <div className="menu-preferences">
                      {allOverviewCards.map((key) => (
                        <label className="switch-row" key={key}>
                          <span>{tr(overviewCardLabels[key])}</span>
                          <input
                            name={'card_' + key}
                            type="checkbox"
                            role="switch"
                            aria-label={tr(overviewCardLabels[key]) + tr('显示')}
                            key={key + String(user.overviewCards)}
                            defaultChecked={(user.overviewCards ?? allOverviewCards).includes(key)}
                          />
                          <span className="switch-state" aria-hidden="true">
                            {tr('显示')}
                          </span>
                        </label>
                      ))}
                    </div>
                    <button className="primary" disabled={busy}>
                      {tr('保存设置')}
                    </button>
                  </form>
                </section>
                <section className="panel" hidden={settingsSection !== 'privacy'}>
                  <h2>{tr('登录与隐私')}</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void act(
                        () =>
                          api('/settings', 'PATCH', {
                            sessionHours: Number(f.get('sessionHours')),
                            idleMinutes: Number(f.get('idleMinutes')),
                            requireHiddenPassword: f.has('requireHiddenPassword'),
                          }),
                        tr('设置已保存'),
                      );
                    }}
                  >
                    <Field label={tr('登录有效期（小时）')}>
                      <input
                        name="sessionHours"
                        type="number"
                        min="1"
                        max="720"
                        step="1"
                        required
                        defaultValue={user.sessionHours ?? 168}
                        key={user.sessionHours}
                      />
                    </Field>
                    <p className="muted">
                      {tr(
                        '范围 1 小时至 30 天（720 小时）。保存后当前登录重新计时，其他会话沿用原到期时间；后续登录使用新设置。',
                      )}
                    </p>
                    {user.sessionExpiresAt && (
                      <p className="muted">
                        {tr('当前会话到期：')}
                        {new Date(user.sessionExpiresAt).toLocaleString(locale, {
                          timeZone: 'Asia/Hong_Kong',
                        })}
                      </p>
                    )}
                    <Field label={tr('无操作自动退出（分钟）')}>
                      <select
                        name="idleMinutes"
                        key={user.idleMinutes}
                        defaultValue={user.idleMinutes}
                      >
                        {[...new Set([0, 5, 15, 30, 60, 120, 1440, user.idleMinutes])]
                          .sort((a, b) => a - b)
                          .map((n) => (
                            <option key={n} value={n}>
                              {n === 0 ? tr('关闭自动退出') : n + tr(' 分钟')}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <p className="muted">
                      {tr(
                        '0 为关闭；最长 1440 分钟。到时退出登录并清除页面数据，浏览器标签页保留。',
                      )}
                    </p>

                    <label className="switch-row">
                      <span>{tr('查看隐藏资产需要密码')}</span>
                      <input
                        name="requireHiddenPassword"
                        type="checkbox"
                        role="switch"
                        aria-label={tr('查看隐藏资产需要密码')}
                        key={String(user.requireHiddenPassword)}
                        defaultChecked={user.requireHiddenPassword !== false}
                      />
                    </label>
                    <p className="muted">
                      {tr(
                        '关闭后，已登录账号可直接显示隐藏资产。每次显示持续 5 分钟，也可手动锁定；保存此设置会锁定所有会话的隐藏资产。',
                      )}
                    </p>
                    <button className="primary" disabled={busy}>
                      {tr('保存设置')}
                    </button>
                  </form>
                </section>
                <section className="panel" hidden={settingsSection !== 'rates'}>
                  <h2>{tr('每日汇率')}</h2>
                  {fxStatus && (
                    <p className="muted" role="status">
                      {tr(fxStatus.message)}
                      {fxStatus.attemptedAt
                        ? ' · ' +
                          new Date(fxStatus.attemptedAt).toLocaleString(locale, {
                            timeZone: 'Asia/Hong_Kong',
                          })
                        : ''}
                    </p>
                  )}
                  <p className="muted">
                    {tr(
                      '服务器每小时检查当日是否已尝试更新。外部请求固定下载公共汇率表，不发送个人数据。失败保留已有汇率，可稍后重试。',
                    )}
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => api('/rates/refresh', 'POST'),
                        tr('汇率已更新至数据源最新可用日期'),
                      )
                    }
                  >
                    <RefreshCw size={16} />
                    {tr('立即更新')}
                  </button>
                  <p className="muted">
                    {tr('公共参考汇率可能与银行成交价不同；休市日日期可能滞后。')}
                  </p>
                </section>
              </div>
              <section className="panel" hidden={settingsSection !== 'rates'}>
                <h2>{tr('已保存汇率')}</h2>
                {rates.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{tr('原币 → 本位币')}</th>
                          <th>{tr('汇率')}</th>
                          <th>{tr('日期')}</th>
                          <th>{tr('来源')}</th>
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
                            <td>{r.source === 'manual' ? tr('历史导入') : 'Frankfurter'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title={tr('没有保存的外币汇率')}
                    body={tr('添加外币项目后更新并保存自动汇率。')}
                  />
                )}
              </section>
              {settingsSection === 'rates' && <MetalPanel refresh={() => load(false, true)} />}
              <section className="panel" hidden={settingsSection !== 'clear'}>
                <h2 className="danger-text">{tr('清空本账号数据')}</h2>
                <p className="muted">
                  {tr(
                    '清除本账号全部账户、资产、债务、历史、私有图标和汇率（包括隐藏资产）；保留登录账号、个人设置和已发布的共享图标。请先下载备份并确认文件已保存。',
                  )}
                </p>
                {clearStep === 0 ? (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void downloadBackup(true)}
                  >
                    <Download size={16} />
                    {tr('第一步：下载备份')}
                  </button>
                ) : clearStep === 1 ? (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        const s = await api<{ ready: boolean }>('/backup/clear-status');
                        if (!s.ready) throw new Error(tr('备份尚未完成，请重新下载'));
                        setClearStep(2);
                      } catch (e) {
                        report(e);
                      }
                    }}
                  >
                    {tr('备份已保存，进入下一步')}
                  </button>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (new FormData(e.currentTarget).get('confirmation') === tr('确定清空'))
                        setClearConfirmation(1);
                    }}
                  >
                    <Field label={tr('输入“确定清空”以确认')}>
                      <input
                        name="confirmation"
                        required
                        pattern={tr('确定清空')}
                        autoComplete="off"
                      />
                    </Field>
                    <button className="danger" disabled={busy}>
                      {tr('清空本账号数据')}
                    </button>
                  </form>
                )}
                {clearStep > 0 && (
                  <button className="text" onClick={() => setClearStep(0)}>
                    {tr('取消清空 / 重新下载')}
                  </button>
                )}
              </section>
              <section className="panel" hidden={settingsSection !== 'backup'}>
                <h2>{tr('数据备份与恢复')}</h2>
                <p className="muted">
                  {tr(
                    'ZIP 内分文件保存可读 JSON，包括全部账户、资产、债务、历史、关联、币种、设置、汇率、图标及配对转账，不限制记录条数；不包含任何认证凭据。备份含个人财务信息，请妥善保管。',
                  )}
                </p>
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void downloadBackup()}
                  >
                    <Download size={16} />
                    {tr('下载我的数据备份')}
                  </button>{' '}
                  <label className="secondary file-button">
                    <Upload size={16} />
                    {tr('选择备份并验证')}
                    <input
                      type="file"
                      accept=".zip,application/zip"
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
                            throw new Error(tr('ZIP 文件不能超过 512 MB（不限制记录条数）'));
                          const form = new FormData();
                          form.append('file', file);
                          const response = await fetch('/api/backup/upload', {
                            method: 'POST',
                            body: form,
                            credentials: 'same-origin',
                          });
                          const result = await response.json();
                          if (!response.ok)
                            throw new ApiError(
                              result.message || tr('ZIP 验证失败'),
                              response.status,
                            );
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
                    <h3>{tr('导入预览')}</h3>
                    <p>
                      {preview.positions} {tr('个项目 ·')}
                      {preview.revisions} {tr('条历史 ·')}
                      {preview.rates} {tr('条汇率')}
                    </p>
                    <p>
                      {tr('备份本位币')}
                      {preview.baseCurrency} {tr('/ 当前本位币')}
                      {preview.currentBaseCurrency}
                    </p>
                    <p>{tr(preview.message)}</p>
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
                        }, tr('备份已完整导入'))
                      }
                    >
                      {tr('确认追加导入')}
                    </button>
                    <button
                      className="text"
                      onClick={() => {
                        setPreview(null);
                        setBackup(null);
                      }}
                    >
                      {tr('取消')}
                    </button>
                  </div>
                )}
              </section>
            </>
          )}
          <footer>{tr('WorthPath · 记录你的积累，理解你的财富')}</footer>
        </div>
      </main>
      {clearConfirmation > 0 && (
        <Modal
          key={clearConfirmation}
          title={
            clearConfirmation === 1
              ? tr('第一次确认：清空本账号数据')
              : tr('第二次确认：清空本账号数据')
          }
          close={() => {
            if (!busy) setClearConfirmation(0);
          }}
        >
          <p className="danger-text">
            {clearConfirmation === 1
              ? tr('将清空本账号全部财务数据及私有图标，请确认备份已保存。')
              : tr('这是最后一次确认。清空后只能通过备份恢复，其他用户的数据不受影响。')}
          </p>
          <p className="muted">{tr('登录账号、个人设置和已发布的共享图标会保留。')}</p>
          <div className="modal-actions clear-confirm-actions">
            {clearConfirmation === 1 ? (
              <>
                <button
                  autoFocus
                  className="secondary"
                  disabled={busy}
                  onClick={() => setClearConfirmation(0)}
                >
                  {tr('取消清空')}
                </button>
                <button className="danger" disabled={busy} onClick={() => setClearConfirmation(2)}>
                  {tr('继续清空')}
                </button>
              </>
            ) : (
              <>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api('/backup/clear', 'POST', { confirmation: tr('确定清空') });
                      setClearConfirmation(0);
                      setClearStep(0);
                      setSelected(null);
                      setBackup(null);
                      setPreview(null);
                    }, tr('本账号数据已清空'))
                  }
                >
                  {busy ? tr('正在清空…') : tr('最终确认清空')}
                </button>
                <button
                  autoFocus
                  className="secondary"
                  disabled={busy}
                  onClick={() => setClearConfirmation(0)}
                >
                  {tr('取消清空')}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
      {modal?.kind === 'group-order' && modal.groups && (
        <Modal title={tr('分组排序')} close={() => !busy && setModal(null)}>
          <GroupOrderList
            groups={modal.groups}
            busy={busy}
            onChange={(groups) =>
              setModal((current) =>
                current?.kind === 'group-order' ? { ...current, groups } : current,
              )
            }
          />
          <div className="modal-actions">
            <button className="secondary" disabled={busy} onClick={() => setModal(null)}>
              {tr('取消')}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    api('/settings', 'PATCH', {
                      accountGroupOrder: mergeGroupOrder(
                        modal.groups!,
                        user.accountGroupOrder || [],
                      ),
                    }),
                  tr('分组顺序已保存'),
                )
              }
            >
              {tr(busy ? '正在保存…' : '保存')}
            </button>
          </div>
        </Modal>
      )}
      {modal?.kind === 'delete-record' && (
        <Modal
          title={tr('删除记录')}
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <p>
            {modal.h
              ? modal.h.name
              : modal.transfer?.source.name + ' ↔ ' + modal.transfer?.target.name}
          </p>
          <p className="muted">{displayTime(modal.h?.time || modal.transfer!.date)}</p>
          <p>
            {tr(
              modal.transfer ||
                modal.h?.reason.startsWith('transfer_') ||
                modal.h?.reason.startsWith('loan_')
                ? '这笔资金往来的双方记录将一起删除，并重算后续余额。'
                : '这条记录将被删除，并重算后续余额。',
            )}
          </p>
          <p className="danger-text">{tr('删除后无法撤销，请确认已保存所需备份。')}</p>

          <div className="modal-actions clear-confirm-actions">
            <button autoFocus disabled={busy} onClick={() => setModal(null)}>
              {tr('取消')}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    api(
                      modal.h
                        ? '/positions/' + modal.h.positionId + '/revisions/' + modal.h.id
                        : '/transfers/' + modal.transfer!.id,
                      'DELETE',
                    ),
                  tr('记录已删除，余额和日历已更新'),
                )
              }
            >
              {busy ? tr('正在处理…') : tr('确认删除')}
            </button>
          </div>
        </Modal>
      )}
      {modal?.kind === 'transfer-edit' && modal.transfer && (
        <Modal
          title={tr('修改资金往来')}
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = modal.transfer!,
                f = Object.fromEntries(new FormData(e.currentTarget));
              void act(
                () =>
                  api('/transfers/' + t.id, 'PUT', {
                    ...f,
                    sourceId: t.sourceId,
                    targetId: t.targetId,
                    operation: t.operation,
                  }),
                tr('记录已修改，余额和日历已更新'),
              );
            }}
          >
            <p>
              {modal.transfer.source.name} ↔ {modal.transfer.target.name}
            </p>
            <Field label={tr('转出金额（') + modal.transfer.sourceCurrency + '）'}>
              <input
                name="amount"
                required
                inputMode="decimal"
                defaultValue={modal.transfer.amount}
              />
            </Field>
            <Field label={tr('实际到账（') + modal.transfer.targetCurrency + '）'}>
              <input
                name="received"
                required
                inputMode="decimal"
                defaultValue={modal.transfer.received}
              />
            </Field>
            <Field label={tr('手续费 / 优惠（') + modal.transfer.sourceCurrency + '）'}>
              <input name="fee" required inputMode="decimal" defaultValue={modal.transfer.fee} />
            </Field>
            <Field label={tr('记录时间（UTC+8）')}>
              <input
                name="date"
                type="datetime-local"
                required
                max={nowMinute()}
                defaultValue={modal.transfer.date}
              />
            </Field>
            <Field label={tr('备注')}>
              <textarea name="notes" maxLength={2000} defaultValue={modal.transfer.notes} />
            </Field>

            <button className="primary" disabled={busy}>
              {tr(busy ? '正在保存…' : '保存')}
            </button>
          </form>
        </Modal>
      )}
      {modal && !['transfer-edit', 'delete-record', 'group-order'].includes(modal.kind) && (
        <Modal
          title={
            modal.kind === 'debt-payment'
              ? modal.p?.kind === 'debt'
                ? operationLabel(modal.p.side === 'asset' ? 'collect' : 'repay')
                : tr('收款 / 还款')
              : modal.kind === 'quick-repayment'
                ? tr('账户还款')
                : modal.kind === 'delete-position'
                  ? '删除' + deletionLabel(modal.p!)
                  : modal.kind === 'transfer'
                    ? tr('转账')
                    : modal.kind === 'reveal'
                      ? tr('验证密码以显示隐藏资产')
                      : modal.kind === 'edit'
                        ? tr('编辑项目')
                        : modal.kind === 'revision'
                          ? tr('更新余额 / 估值')
                          : modal.kind === 'correction'
                            ? tr('更正历史记录')
                            : modal.kind === 'links'
                              ? tr('管理债务关联')
                              : tr('新增') + tr(labels[modal.kind])
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal.kind === 'delete-position' && modal.p ? (
            <PositionDeletion
              position={modal.p}
              busy={busy}
              cancel={() => setModal(null)}
              remove={(confirmation) =>
                void act(
                  async () => {
                    await api('/positions/' + modal.p!.id, 'DELETE', { confirmation });
                    setSelected(null);
                  },
                  deletionLabel(modal.p!) + '已删除',
                )
              }
            />
          ) : modal.kind === 'quick-repayment' && modal.p ? (
            <QuickRepayment
              target={modal.p}
              accounts={positions}
              busy={busy}
              submit={(data) =>
                void act(
                  () => saveQuickMovement(data, tr('还款')),
                  tr('还款已保存，双方余额已更新'),
                )
              }
            />
          ) : ['transfer', 'debt-payment'].includes(modal.kind) ? (
            movementLoading ? (
              <p>{tr('正在刷新数据…')}</p>
            ) : modal.kind === 'transfer' ? (
              <TransferForm
                accounts={movementPositions.filter((p) => p.kind === 'account' && !p.archived)}
                initialSourceId={modal.p?.kind === 'account' ? modal.p.id : undefined}
                busy={busy}
                submit={(v) =>
                  void act(() => api('/transfers', 'POST', v), tr('转账已保存，双方余额已更新'))
                }
              />
            ) : (
              <DebtPaymentForm
                accounts={movementPositions.filter(
                  (p) => p.kind === 'account' && p.side === 'asset' && !p.archived,
                )}
                debts={movementPositions.filter((p) => p.kind === 'debt' && !p.archived)}
                initialAccount={
                  modal.p?.kind === 'account'
                    ? modal.p.id
                    : modal.p?.outgoing.find((link) =>
                        movementPositions.some(
                          (p) =>
                            p.id === link.targetId &&
                            p.kind === 'account' &&
                            p.side === 'asset' &&
                            !p.archived,
                        ),
                      )?.targetId
                }
                initialDebt={modal.p?.kind === 'debt' ? modal.p.id : undefined}
                initialOperation={modal.operation}
                busy={busy}
                submit={(v) =>
                  void act(() => api('/transfers', 'POST', v), tr('账户与债务已同步更新'))
                }
              />
            )
          ) : (
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
                    tr('隐藏资产已解锁 5 分钟'),
                  );
                } else if (kind === 'links') {
                  void act(
                    () =>
                      api('/positions/' + mp!.id + '/links', 'PUT', {
                        targetIds: f.getAll('targetIds'),
                      }),
                    tr('关联已更新'),
                  );
                } else if (kind === 'revision' || kind === 'correction') {
                  void act(
                    () =>
                      modal.h
                        ? api('/positions/' + mp!.id + '/revisions/' + modal.h.id, 'PUT', {
                            ...v,
                            amount: accountInputAmount(mp!, String(v.amount)),
                          })
                        : saveQuickBalance(
                            mp!,
                            { ...v, amount: accountInputAmount(mp!, String(v.amount)) },
                            !!modal.quick,
                          ),
                    tr('金额历史已保存，总览已重新计算'),
                  );
                } else if (kind === 'edit') {
                  void act(
                    () =>
                      api('/positions/' + mp!.id, 'PATCH', {
                        ...v,
                        ...(f.has('iconId') ? { iconId: f.get('iconId') || null } : {}),
                        archived: mp!.archived,
                        hidden: f.get('hidden') === 'on',
                        included: f.get('included') === 'on',
                      }),
                    tr('项目资料已保存'),
                  );
                } else if (kind === 'asset' && v.category === 'gold') {
                  void act(
                    () =>
                      api('/metals/holdings', 'POST', {
                        name: v.name,
                        currency: v.currency,
                        notes: v.notes,
                        date: v.date,
                        metalType: v.metalType,
                        metalGrams: v.metalGrams,
                        metalCostPerGram: v.metalCostPerGram || null,
                        autoValuation: true,
                        hidden: f.has('hidden'),
                        included: f.has('included'),
                      }),
                    tr('项目已添加'),
                  );
                } else {
                  const category = String(v.category),
                    side =
                      kind === 'account' && ['credit_card', 'loan'].includes(category)
                        ? 'liability'
                        : kind === 'debt'
                          ? String(v.side)
                          : 'asset';
                  void act(
                    () =>
                      api('/positions', 'POST', {
                        ...v,
                        ...(f.has('iconId') ? { iconId: f.get('iconId') || null } : {}),
                        kind,
                        side,
                        amount: accountInputAmount({ kind, side }, String(v.amount)),
                        hidden: f.get('hidden') === 'on',
                        included: f.get('included') === 'on',
                      }),
                    tr('项目已添加'),
                  );
                }
              }}
            >
              {modal.kind === 'reveal' && (
                <Field label={tr('登录密码')}>
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
                    <input
                      name="included"
                      type="checkbox"
                      defaultChecked={modal.p?.included !== false}
                    />
                    {tr('计入资产总览')}
                  </label>
                  <p className="muted">
                    {tr('取消后不参与资产、负债及净资产轨迹，仍可管理和转账。')}
                  </p>
                  <label className="check-line">
                    <input name="hidden" type="checkbox" defaultChecked={modal.p?.hidden} />
                    {tr('隐藏此项目（密码验证后可查看和编辑）')}
                  </label>
                  {(modal.kind === 'account' || modal.p?.kind === 'account') && (
                    <>
                      <IconPicker key={modal.p?.id || 'new-account'} initialId={modal.p?.iconId} />
                      <Field label={tr('账户分组')}>
                        <input
                          name="groupName"
                          maxLength={60}
                          defaultValue={modal.p?.groupName || ''}
                          list="account-groups"
                          placeholder={tr('例如：日常、消费、理财')}
                        />
                        <datalist id="account-groups">
                          {groups.filter(Boolean).map((g) => (
                            <option key={g} value={g} />
                          ))}
                        </datalist>
                      </Field>
                    </>
                  )}
                  <Field label={tr('名称')}>
                    <input
                      name="name"
                      defaultValue={modal.p?.name}
                      required
                      maxLength={100}
                      autoFocus
                    />
                  </Field>
                  <Field label={tr('类别')}>
                    <select
                      name="category"
                      onChange={(e) => setNewAssetCategory(e.target.value)}
                      defaultValue={modal.p?.category || categories[modal.kind]?.[0][0]}
                    >
                      {categories[modal.p?.kind || modal.kind].map(([v, label]) => (
                        <option key={v} value={v}>
                          {tr(label)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {modal.kind === 'account' && (
                    <p className="muted">
                      {tr('信用卡、贷款账户：负数为欠款，正数为溢缴存款；其余账户按实际余额填写。')}
                    </p>
                  )}
                </>
              )}
              {modal.kind === 'debt' && (
                <>
                  <Field label={tr('债务方向')}>
                    <select name="side" defaultValue="liability">
                      <option value="liability">{tr('欠款（待还）')}</option>
                      <option value="asset">{tr('借款（待收）')}</option>
                    </select>
                  </Field>
                  <p className="muted">
                    {tr(
                      '已有债务填写剩余本金；新借入或借出可先填0，保存后通过账户联动操作记录资金。',
                    )}
                  </p>
                </>
              )}
              {['account', 'asset', 'debt'].includes(modal.kind) && (
                <Field label={tr('原币币种')}>
                  <select name="currency" defaultValue={user.baseCurrency}>
                    {currencies.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              )}
              {['account', 'asset', 'debt', 'revision', 'correction'].includes(modal.kind) &&
                !(modal.kind === 'asset' && newAssetCategory === 'gold') && (
                  <Field
                    label={
                      tr(
                        modal.p?.kind === 'debt'
                          ? '剩余本金'
                          : modal.p?.kind === 'asset'
                            ? '当前估值'
                            : '当前余额',
                      ) + (modal.p ? '（' + modal.p.currency + '）' : '')
                    }
                  >
                    <input
                      name="amount"
                      inputMode="decimal"
                      required
                      pattern={
                        modal.p?.kind === 'account' || modal.kind === 'account'
                          ? '-?(0|[1-9][0-9]{0,15})(\\.[0-9]{1,8})?'
                          : '(0|[1-9][0-9]{0,15})(\\.[0-9]{1,8})?'
                      }
                      defaultValue={
                        modal.p
                          ? accountInputAmount(modal.p, modal.h?.after || modal.p.amount)
                          : modal.kind === 'debt'
                            ? '0'
                            : ''
                      }
                      placeholder="0.00"
                    />
                  </Field>
                )}
              {modal.kind === 'asset' && newAssetCategory === 'gold' && (
                <>
                  <Field label={tr('贵金属品种')}>
                    <select name="metalType">
                      <option value="gold">{tr('黄金')}</option>
                      <option value="silver">{tr('白银')}</option>
                    </select>
                  </Field>
                  <Field label={tr('重量（克）')}>
                    <input
                      name="metalGrams"
                      required
                      inputMode="decimal"
                      pattern="(0|[1-9][0-9]{0,15})([.][0-9]{1,8})?"
                    />
                  </Field>
                  <Field label={tr('买入价（每克，选填）')}>
                    <input
                      name="metalCostPerGram"
                      inputMode="decimal"
                      pattern="(0|[1-9][0-9]{0,11})([.][0-9]{1,12})?"
                    />
                  </Field>
                  <p className="muted">
                    {tr('按克数添加，参考价自动估值；缺少报价时显示待估值，不计为已知零价值。')}
                  </p>
                </>
              )}
              {['account', 'asset', 'debt', 'revision', 'correction'].includes(modal.kind) && (
                <Field label={tr('记录时间（UTC+8）')}>
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
              {['revision', 'correction'].includes(modal.kind) &&
                modal.p?.kind === 'account' &&
                modal.p.side === 'liability' && (
                  <p className="muted">
                    {tr('负数表示欠款，正数表示溢缴存款；溢缴部分计入总资产。')}
                  </p>
                )}
              {modal.kind === 'revision' && modal.quick && modal.p?.side === 'liability' && (
                <>
                  <div className="actions quick-repayment-actions">
                    {canQuickRepay(modal.p) && (
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          setModal({ kind: 'quick-repayment', p: modal.p, quick: true })
                        }
                      >
                        {tr('还款')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(() => markQuickRepayment(modal.p!), tr('还款标记已保存'))
                      }
                    >
                      {tr(
                        isPaidForMonth(modal.p, repaymentMonth)
                          ? '取消本月已还款'
                          : '标记本月已还款',
                      )}
                    </button>
                  </div>
                  <p className="muted">
                    {tr('还款会更新双方余额；月份标记只记录本月已处理，不改变金额。')}
                  </p>
                </>
              )}
              {modal.kind === 'revision' && (
                <>
                  <Field label={tr('变更原因')}>
                    <select
                      name="reason"
                      defaultValue={modal.p?.kind === 'asset' ? 'valuation' : 'balance'}
                    >
                      <option value="balance">{tr('余额更新')}</option>
                      <option value="valuation">{tr('估值更新')}</option>
                      {modal.p?.side === 'liability' && (
                        <option value="repayment">{tr('还款（填写还款后欠款）')}</option>
                      )}
                    </select>
                  </Field>
                  <p className="muted">
                    {tr(
                      '填写更新后的余额或剩余欠款，每次保存会新增历史。已有错误记录请在历史中更正。',
                    )}
                  </p>
                </>
              )}
              {modal.kind === 'correction' && (
                <p className="notice warning">
                  {tr('这将修改选中的历史金额并重算后续变化，请确认日期和余额。')}
                </p>
              )}
              {modal.kind === 'links' ? (
                <div className="link-options">
                  {linkOptions.length ? (
                    linkOptions.map((p) => (
                      <label key={p.id}>
                        <input
                          type="checkbox"
                          name="targetIds"
                          value={p.id}
                          defaultChecked={modal.p!.outgoing.some((l) => l.targetId === p.id)}
                        />
                        {p.name} · {tr(labels[p.kind])}
                      </label>
                    ))
                  ) : (
                    <p>{tr('请先创建账户或独立资产。')}</p>
                  )}
                </div>
              ) : (
                modal.kind !== 'reveal' && (
                  <Field label={tr('备注')}>
                    <textarea
                      name="notes"
                      maxLength={2000}
                      rows={3}
                      defaultValue={modal.h?.notes || modal.p?.notes || ''}
                    />
                  </Field>
                )
              )}

              <div className="modal-actions">
                <button
                  className="secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  {tr('取消')}
                </button>
                <button className="primary" disabled={busy}>
                  {busy
                    ? tr('正在保存…')
                    : modal.kind === 'correction'
                      ? tr('确认更正')
                      : tr('保存')}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
      {draftId && (
        <AgentDrafts
          initialId={draftId}
          close={() => {
            setDraftId(null);
            const url = new URL(location.href);
            url.searchParams.delete('agent_operation');
            if (url.pathname === '/agent/operation') url.pathname = '/';
            history.replaceState(null, '', url.pathname + url.search + url.hash);
          }}
          changed={() => void load()}
        />
      )}
    </div>,
  );
}
function HistoryTable({
  rows,
  open,
  correct,
  remove,
  busy = false,
}: {
  rows: History[];
  open?: (id: string) => void;
  correct?: (h: History) => void;
  remove?: (h: History) => void;
  busy?: boolean;
}) {
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{tr('项目 / 日期')}</th>
            <th>{tr('变更前')}</th>
            <th>{tr('变更后')}</th>
            <th>{tr('变化额')}</th>
            <th className="notes-cell">{tr('备注')}</th>
            {correct && <th>{tr('操作')}</th>}
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
                        initial: tr('初始记录'),
                        scheduled_expense: tr('计划支出'),
                        balance: tr('余额更新'),
                        valuation: tr('估值更新'),
                        repayment: tr('还款'),
                        correction: tr('更正'),
                        transfer_out: tr('转账转出'),
                        transfer_in: tr('转账到账'),
                        loan_borrow: tr('借入到账'),
                        loan_lend: tr('借出付款'),
                        loan_collect: tr('收回借款'),
                        loan_repay: tr('偿还债务'),
                      } as Record<string, string>
                    )[h.reason]
                  }
                </small>
              </td>
              <td
                className={
                  positionAmount(h, h.before).startsWith('-') ? 'danger-text' : 'income-text'
                }
              >
                {money(positionAmount(h, h.before), h.currency)}
              </td>
              <td
                className={
                  positionAmount(h, h.after).startsWith('-') ? 'danger-text' : 'income-text'
                }
              >
                {money(positionAmount(h, h.after), h.currency)}
              </td>
              <td
                className={
                  positionAmount(h, h.delta).startsWith('-') ? 'danger-text' : 'income-text'
                }
              >
                {money(positionAmount(h, h.delta), h.currency)}
              </td>
              <td className="notes-cell">{h.notes || '—'}</td>
              {correct && (
                <td className="record-actions">
                  <button className="text" disabled={busy} onClick={() => correct(h)}>
                    {tr(
                      h.reason.startsWith('transfer_') || h.reason.startsWith('loan_')
                        ? '修改资金往来'
                        : '更正',
                    )}
                  </button>
                  {remove && (
                    <button className="text danger-text" disabled={busy} onClick={() => remove(h)}>
                      {tr('删除')}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title={tr('暂无变化记录')} body={tr('添加项目或更新金额后，历史会自动保存在这里。')} />
  );
}
