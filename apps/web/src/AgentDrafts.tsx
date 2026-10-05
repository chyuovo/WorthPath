import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import { AgentOperation, Fields, type Preview } from './AgentReview';
import { toolLabel, statusLabel } from './agent-display';
import { showToast } from './Toast';

export function ReviewDialog({
  children,
  close,
  busy = false,
  title = '审阅草稿',
}: {
  children: ReactNode;
  close: () => void;
  busy?: boolean;
  title?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="veil"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className="modal draft-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !busy) {
            e.preventDefault();
            close();
          }
          if (e.key === 'Tab') {
            const nodes = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),a[href],select:not(:disabled),summary',
              ) || [],
            );
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (!first) {
              e.preventDefault();
              return;
            }
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === ref.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (
              !e.shiftKey &&
              (document.activeElement === last || document.activeElement === ref.current)
            ) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" aria-label="关闭" disabled={busy} onClick={close}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>,
    document.body,
  );
}
type Draft = Preview & { error?: string };
export function AgentDrafts({
  initialId,
  close,
  changed,
}: {
  initialId?: string;
  close: () => void;
  changed: () => void;
}) {
  const [items, setItems] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(false);
  const [now, setNow] = useState(Date.now());
  async function load(initial = false) {
    setLoading(true);
    setError('');
    try {
      const all: Draft[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Draft[]; nextCursor: string | null } = await api(
          '/agent/drafts' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      setItems(all);
      setSelected(initial && initialId ? [initialId] : []);
      setDetail(!!initialId && !all.some((o) => o.operationId === initialId));
    } catch (e) {
      setError(e instanceof Error ? e.message : '草稿加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load(true);
  }, [initialId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const valid = items.filter(
    (o) => o.status === 'pending' && !o.error && new Date(o.expiresAt).getTime() > now,
  );
  const eligible = selected.filter((id) => valid.some((o) => o.operationId === id));
  async function decide(approve: boolean) {
    if (busy || !eligible.length || eligible.length > 100) return;
    setBusy(true);
    setError('');
    try {
      await api('/agent/operations/confirm-batch', 'POST', {
        approve,
        operationIds: eligible,
      });
      showToast(approve ? '所选草稿已全部执行' : '所选草稿已取消', 'success');
      changed();
      await load();
    } catch (e) {
      const message = e instanceof Error ? e.message : '提交失败';
      setError(message + '。本批修改未执行，请刷新后重新审阅。');
      showToast(message, 'error');
    } finally {
      setBusy(false);
    }
  }
  async function cancelUnavailable(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api('/agent/operations/' + id, 'POST', { approve: false });
      changed();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '取消失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReviewDialog close={close} busy={busy}>
      {loading ? (
        <p>正在读取全部草稿…</p>
      ) : detail ? (
        <AgentOperation id={initialId || null} changed={changed} />
      ) : (
        <>
          <p className="muted">核对每项修改后选择。一次最多同意 100 项，任一失败整批回滚。</p>
          <div className="draft-toolbar">
            <button
              className="secondary"
              disabled={busy || !valid.length}
              onClick={() => setSelected(valid.slice(0, 100).map((o) => o.operationId))}
            >
              {valid.length > 100 ? '选择前 100 项' : '全选'}
            </button>
            <button className="secondary" disabled={busy} onClick={() => setSelected([])}>
              取消全选
            </button>
            <button className="secondary" disabled={busy} onClick={() => void load()}>
              刷新草稿
            </button>
            <span role="status">
              已选择 {eligible.length} / {items.length} 项
            </span>
          </div>
          {!items.length && <p>没有等待确认的修改。</p>}
          <div className="draft-list">
            {items.map((o) => {
              const available = valid.some((v) => v.operationId === o.operationId);
              const p = o.impact?.parameters || {},
                refs = o.impact?.references || {};
              const ref = refs[String(p.id || p.sourceId || '')];
              const absolute = ['balance_record', 'history_update', 'position_create'].includes(
                o.tool,
              );
              return (
                <article className="draft-card" key={o.operationId}>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      disabled={busy || !available}
                      checked={eligible.includes(o.operationId)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, o.operationId]
                            : ids.filter((id) => id !== o.operationId),
                        )
                      }
                    />
                    <strong>{toolLabel(o.tool)}</strong>
                    <span>
                      {o.connectionName} · {statusLabel(available ? o.status : 'expired')}
                    </span>
                  </label>
                  {o.error ? (
                    <div>
                      <p className="danger-text">{o.error}</p>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void cancelUnavailable(o.operationId)}
                      >
                        取消草稿
                      </button>
                    </div>
                  ) : (
                    <>
                      {o.destructive && (
                        <p className="agent-warning">删除记录并重算余额，请仔细核对。</p>
                      )}
                      {o.impact.current && (
                        <details open>
                          <summary>当前记录</summary>
                          <Fields
                            data={o.impact.current}
                            references={refs}
                            currency={ref?.currency}
                            liability={absolute && ref?.side === 'liability'}
                          />
                        </details>
                      )}
                      <Fields
                        data={
                          o.tool === 'position_create'
                            ? Object.fromEntries(
                                Object.entries(p).filter(
                                  ([key, value]) =>
                                    !['hidden', 'archived', 'notes'].includes(key) ||
                                    (value !== false && value !== '' && value !== null),
                                ),
                              )
                            : p
                        }
                        references={refs}
                        currency={ref?.currency}
                        liability={
                          absolute && (ref?.side === 'liability' || p.side === 'liability')
                        }
                      />
                      {o.tool === 'position_create' && (
                        <details className="agent-details">
                          <summary>查看全部字段</summary>
                          <Fields data={p} references={refs} liability={p.side === 'liability'} />
                        </details>
                      )}
                      <small className="muted">
                        有效至 {new Date(o.expiresAt).toLocaleString()}
                      </small>
                    </>
                  )}
                </article>
              );
            })}
          </div>
          <div className="draft-footer">
            <button className="secondary" disabled={busy} onClick={close}>
              稍后处理
            </button>
            <button
              className="secondary"
              disabled={busy || !eligible.length || eligible.length > 100}
              onClick={() => void decide(false)}
            >
              取消所选草稿
            </button>
            <button
              className="primary"
              disabled={busy || !eligible.length || eligible.length > 100}
              onClick={() => void decide(true)}
            >
              {busy ? '正在执行…' : '同意所选 ' + eligible.length + ' 项'}
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
          <button className="secondary" disabled={busy} onClick={() => void load()}>
            重新加载
          </button>
        </p>
      )}
    </ReviewDialog>
  );
}
