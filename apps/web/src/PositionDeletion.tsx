import { useEffect, useState } from 'react';
import { api, type Position } from './api';
import { showToast } from './Toast';
type Impact = {
  name: string;
  historyCount: number;
  movementCount: number;
  scheduleCount: number;
  linkCount: number;
  canDelete: boolean;
};
export function deletionLabel(position: Pick<Position, 'kind'>) {
  return position.kind === 'asset' ? '独立资产' : position.kind === 'debt' ? '债务' : '账户';
}
export function PositionDeletion({
  position,
  busy,
  cancel,
  remove,
}: {
  position: Position;
  busy: boolean;
  cancel: () => void;
  remove: (name: string) => void;
}) {
  const [impact, setImpact] = useState<Impact | null>(null),
    [name, setName] = useState('');
  useEffect(() => {
    let active = true;
    void api<Impact>('/positions/' + position.id + '/deletion')
      .then((v) => {
        if (active) setImpact(v);
      })
      .catch((e) => {
        if (active) showToast(e.message, 'error');
      });
    return () => {
      active = false;
    };
  }, [position.id]);
  const label = deletionLabel(position);
  const history =
    position.kind === 'asset' ? '估值历史' : position.kind === 'debt' ? '借贷历史' : '余额历史';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (impact?.canDelete && name === impact.name && !busy) remove(name);
      }}
    >
      <h3>
        删除{label}「{position.name}」
      </h3>
      {!impact ? (
        <p>正在检查关联记录…</p>
      ) : (
        <>
          <p>
            删除后将移除该{label}、{impact.historyCount} 条{history}及 {impact.linkCount}{' '}
            个债务关联。资产总览、趋势和收支日历将同步更新，无法撤销。
          </p>
          {!impact.canDelete ? (
            <div className="agent-warning" role="status">
              <strong>请先处理关联记录</strong>
              <p>
                还有 {impact.movementCount} 条资金往来、{impact.scheduleCount}{' '}
                个定时计划。请先撤销相关资金往来并删除相关计划，再删除{label}
                。若需要保留历史，可改用归档。
              </p>
            </div>
          ) : (
            <label>
              输入完整{label}名称确认删除
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          )}
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="secondary" disabled={busy} onClick={cancel}>
          返回
        </button>
        <button
          className="primary danger"
          disabled={busy || !impact?.canDelete || name !== impact.name}
        >
          删除{label}
        </button>
      </div>
    </form>
  );
}
