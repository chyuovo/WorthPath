import { useEffect, useState } from 'react';
import { api, money } from './api';
import { showToast } from './Toast';
import {
  displayValue,
  fieldLabels,
  permissionLabel,
  statusLabel,
  toolLabel,
  type Reference,
} from './agent-display';
type Consent = {
  id: string;
  name: string;
  scopes: string[];
  availableScopes: string[];
  canWrite: boolean;
  redirectUri: string;
  resource: string;
};
export type Preview = {
  operationId: string;
  tool: string;
  status: string;
  description: string;
  expiresAt: string;
  connectionName: string;
  destructive: boolean;
  impact: {
    parameters: Record<string, unknown>;
    references: Record<string, Reference>;
    current?: Record<string, unknown>;
  };
  result?: unknown;
};
function ReviewError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <section className="panel">
      <h2>暂时无法加载</h2>
      <p>{message}</p>
      <button className="secondary" onClick={retry}>
        重新加载
      </button>{' '}
      <a href="/">返回资产空间</a>
    </section>
  );
}
export function AgentAuthorization({ id }: { id: string | null }) {
  const [consent, setConsent] = useState<Consent | null>(null),
    [level, setLevel] = useState('read'),
    [days, setDays] = useState('30'),
    [hiddenRead, setHiddenRead] = useState(false),
    [hiddenWrite, setHiddenWrite] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setConsent(null);
    setError('');
    setLevel('read');
    setDays('30');
    setHiddenRead(false);
    setHiddenWrite(false);
    if (!id) {
      setError('授权链接缺少请求编号，请从客户端重新发起连接。');
      return;
    }
    void api<Consent>('/agent/authorizations/' + id)
      .then((v) => {
        if (active) setConsent(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, reload]);
  const selected = consent
    ? [
        'read',
        ...(level !== 'read' && consent.canWrite ? [level] : []),
        ...(hiddenRead && consent.scopes.includes('hidden_read') ? ['hidden_read'] : []),
        ...(hiddenWrite &&
        hiddenRead &&
        level !== 'read' &&
        consent.canWrite &&
        consent.scopes.includes('hidden_write')
          ? ['hidden_write']
          : []),
      ]
    : [];
  async function decide(approve: boolean) {
    if (!consent || busy) return;
    setBusy(true);
    try {
      const v = await api<{ redirect: string }>('/agent/authorizations/' + consent.id, 'POST', {
        approve,
        scopes: selected,
        days: days === 'permanent' ? null : Number(days),
      });
      location.assign(v.redirect);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '授权失败', 'error');
      setBusy(false);
    }
  }
  if (error) return <ReviewError message={error} retry={() => setReload((v) => v + 1)} />;
  if (!consent)
    return (
      <section className="panel">
        <p>正在读取连接请求…</p>
      </section>
    );
  return (
    <section className="panel agent-consent-card">
      <span className="badge">连接授权</span>
      <h1>允许「{consent.name}」连接 WorthPath？</h1>
      <p className="muted">选择它可以访问的范围。你可以随时在连接管理中撤销授权。</p>
      <div className="agent-permission-choices" role="group" aria-label="连接权限">
        {[
          ['read', '只读查询', '查看账户和统计，无法修改账目。'],
          ['draft', '草稿修改', '提出修改，由你逐项确认后执行。'],
          ['write', '直接写入', '普通账目修改立即执行，无需逐次确认。'],
        ]
          .filter(([key]) => consent.availableScopes.includes(key))
          .map(([key, title, detail]) => (
            <button
              key={key}
              className={level === key ? 'permission-choice selected' : 'permission-choice'}
              disabled={busy || (key !== 'read' && !consent.canWrite)}
              aria-pressed={level === key}
              onClick={() => {
                setLevel(key);
                if (key === 'read') setHiddenWrite(false);
              }}
            >
              <strong>{title}</strong>
              <span>{detail}</span>
            </button>
          ))}
      </div>
      {level === 'write' && (
        <p className="agent-warning">
          直接写入会立即修改账目，无需逐次网页确认。请仅授予你信任的助手。
        </p>
      )}
      {!consent.canWrite && <p className="muted">你的账号为只读用户，只能授予查询权限。</p>}
      <label className="agent-duration">
        授权有效期
        <select value={days} disabled={busy} onChange={(e) => setDays(e.target.value)}>
          {[
            ['1', '1 天'],
            ['3', '3 天'],
            ['7', '7 天'],
            ['30', '30 天'],
            ['365', '1 年（365 天）'],
            ['permanent', '永久（可撤销）'],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <small>有限期限到期后重新授权；永久授权仍可随时撤销。</small>
      </label>
      {consent.scopes.includes('hidden_read') && (
        <fieldset className="agent-scope-options">
          <legend>隐藏账户（默认不授权）</legend>
          <label className="check-line">
            <input
              type="checkbox"
              disabled={busy}
              checked={hiddenRead}
              onChange={(e) => {
                setHiddenRead(e.target.checked);
                if (!e.target.checked) setHiddenWrite(false);
              }}
            />
            允许读取隐藏账户
          </label>
          {consent.scopes.includes('hidden_write') && (
            <label className="check-line">
              <input
                type="checkbox"
                disabled={busy || !consent.canWrite || !hiddenRead || level === 'read'}
                checked={hiddenWrite}
                onChange={(e) => setHiddenWrite(e.target.checked)}
              />
              允许修改隐藏账户
            </label>
          )}
        </fieldset>
      )}
      <div className="agent-final-permission" role="status">
        <strong>最终授权：{permissionLabel(selected)}</strong>
        <span>
          授权期限：
          {days === 'permanent'
            ? '永久（可撤销）'
            : days === '365'
              ? '1 年（365 天）'
              : days + ' 天'}
        </span>
        <span>
          隐藏账户：{hiddenRead ? (hiddenWrite ? '可读取和修改' : '仅可读取') : '不可访问'}
        </span>
      </div>
      <details className="agent-details">
        <summary>核对客户端与授权地址</summary>
        <dl className="agent-fields">
          <dt>服务地址</dt>
          <dd>{consent.resource}</dd>
          <dt>回调地址</dt>
          <dd>{consent.redirectUri}</dd>
          <dt>客户端申请权限</dt>
          <dd>{consent.scopes.join(', ')}</dd>
          <dt>最终权限代码</dt>
          <dd>{selected.join(', ')}</dd>
        </dl>
        <p>
          普通权限等级由你在此选择，可以高于客户端申请范围；隐藏访问仅限客户端已申请的范围。最终仅授予上方明确选中的权限。只批准你正在连接并信任的客户端。
        </p>
      </details>
      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
          拒绝授权
        </button>
        <button
          className="primary"
          disabled={busy || !selected.includes('read')}
          onClick={() => void decide(true)}
        >
          {busy ? '正在处理…' : '授权此连接'}
        </button>
      </div>
    </section>
  );
}
export function Fields({
  data,
  references,
  currency,
  receivedCurrency,
  liability = false,
}: {
  data: unknown;
  references: Record<string, Reference>;
  currency?: string;
  receivedCurrency?: string;
  liability?: boolean;
}) {
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return <p>{displayValue(data, references)}</p>;
  const entries = Object.entries(data as Record<string, unknown>);
  const object = data as Record<string, unknown>;
  const localCurrency =
    typeof object.currency === 'string'
      ? object.currency
      : references[String(object.sourceId || object.id || '')]?.currency || currency;
  const targetCurrency =
    references[String(object.targetId || '')]?.currency || receivedCurrency || localCurrency;
  return (
    <dl className="agent-fields">
      {entries.map(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value))
          return (
            <div className="agent-field-section" key={key}>
              <h3>{key === 'data' ? '修改内容' : fieldLabels[key] || key}</h3>
              <Fields
                data={value}
                references={references}
                currency={localCurrency}
                receivedCurrency={targetCurrency}
                liability={liability}
              />
            </div>
          );
        const amount =
          ['amount', 'received', 'fee', 'metalCostPerGram', 'costPerGram'].includes(key) &&
          typeof value === 'string' &&
          /^-?\d+(\.\d+)?$/.test(value);
        let shown = displayValue(value, references);
        const fieldCurrency = key === 'received' ? targetCurrency : localCurrency;
        if (amount && fieldCurrency) {
          let v = String(value);
          if (key === 'amount' && liability && !/^-?0(\.0+)?$/.test(v))
            v = v.startsWith('-') ? v.slice(1) : '-' + v;
          shown = money(v, fieldCurrency);
        }
        return (
          <div className="agent-field" key={key}>
            <dt>{fieldLabels[key] || key}</dt>
            <dd>{shown}</dd>
          </div>
        );
      })}
    </dl>
  );
}
export function AgentOperation({ id, changed }: { id: string | null; changed?: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    setPreview(null);
    setError('');
    if (!id) {
      setError('草稿链接缺少操作编号，请从操作记录重新打开。');
      return;
    }
    void api<Preview>('/agent/operations/' + id)
      .then((v) => {
        if (active) setPreview(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, reload]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function decide(approve: boolean) {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await api('/agent/operations/' + preview.operationId, 'POST', { approve });
      setPreview(await api<Preview>('/agent/operations/' + preview.operationId));
      changed?.();
      showToast(approve ? '修改已完成，Agent 可以查询结果' : '草稿已取消', 'success');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  }
  if (error) return <ReviewError message={error} retry={() => setReload((v) => v + 1)} />;
  if (!preview)
    return (
      <section className="panel">
        <p>正在读取草稿…</p>
      </section>
    );
  const expired = preview.status === 'pending' && new Date(preview.expiresAt).getTime() <= now;
  const pending = preview.status === 'pending' && !expired;
  const params = preview.impact.parameters,
    refs = preview.impact.references || {};
  const ref = refs[String(params.id || params.sourceId || '')];
  const absolute = ['balance_record', 'history_update', 'position_create'].includes(preview.tool);
  const currency =
    ref?.currency ||
    refs[String(preview.impact.current?.sourceId || '')]?.currency ||
    (typeof params.currency === 'string' ? params.currency : undefined);
  const receivedCurrency =
    refs[String(params.targetId || preview.impact.current?.targetId || '')]?.currency;
  return (
    <section className="panel agent-consent-card">
      <span className="badge">{statusLabel(expired ? 'expired' : preview.status)}</span>
      <h1>{toolLabel(preview.tool)}</h1>
      <p className="muted">来自连接：{preview.connectionName}</p>
      {pending && <p>请核对下方内容。确认后修改才会写入账目。</p>}
      {absolute && (
        <p className="agent-final-permission">金额为变更后的余额或估值；负债按欠款显示为负数。</p>
      )}
      {preview.destructive && (
        <div className="agent-warning">这项操作会删除记录并重算相关余额，请核对后再确认。</div>
      )}
      {preview.impact.current && (
        <section className="agent-existing">
          <h3>当前记录</h3>
          <Fields
            data={preview.impact.current}
            references={refs}
            currency={currency}
            liability={
              ['balance_record', 'history_update', 'history_delete'].includes(preview.tool) &&
              ref?.side === 'liability'
            }
          />
        </section>
      )}
      <h3>{preview.destructive ? '操作对象' : '提交的修改'}</h3>
      <Fields
        data={params}
        references={refs}
        currency={currency}
        receivedCurrency={receivedCurrency}
        liability={absolute && (ref?.side === 'liability' || params.side === 'liability')}
      />
      {pending && (
        <p className="muted">
          有效至{' '}
          {new Date(preview.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' })}
          （UTC+8）。账目发生变化时，需要 Agent 重新创建草稿。
        </p>
      )}
      {expired && <p className="agent-warning">草稿已过期，请让 Agent 重新创建。</p>}
      {preview.status === 'completed' && <p role="status">这项修改已经执行完成。</p>}
      {preview.result !== undefined && preview.result !== null && (
        <details className="agent-details">
          <summary>查看执行结果</summary>
          <Fields data={preview.result} references={refs} />
        </details>
      )}
      <details className="agent-details">
        <summary>查看工具说明</summary>
        <code>{preview.tool}</code>
        <p>{preview.description}</p>
      </details>
      <div className="modal-actions">
        <a href="/">返回资产空间</a>
        {pending && (
          <>
            <button className="secondary" disabled={busy} onClick={() => void decide(false)}>
              取消草稿
            </button>
            <button className="primary" disabled={busy} onClick={() => void decide(true)}>
              {busy ? '正在处理…' : '确认执行'}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
