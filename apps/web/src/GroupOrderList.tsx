import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { GripVertical } from 'lucide-react';
import { t as tr } from './i18n';
import { moveGroup } from './group-order';

export function GroupOrderList({
  groups,
  onChange,
  busy,
}: {
  groups: string[];
  onChange: (groups: string[]) => void;
  busy: boolean;
}) {
  const list = useRef<HTMLOListElement>(null),
    help = useId();
  const current = useRef({ groups, onChange });
  current.current = { groups, onChange };
  const drag = useRef<{ group: string; pointer: number; initial: string[]; y: number } | null>(
    null,
  );
  const frame = useRef<number | null>(null);
  const [active, setActive] = useState<string | null>(null),
    [announcement, setAnnouncement] = useState('');
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  function move(from: number, to: number) {
    const next = moveGroup(current.current.groups, from, to);
    if (next === current.current.groups) return;
    current.current.groups = next;
    current.current.onChange(next);
    setAnnouncement((next[to] || tr('未分组')) + ' · ' + (to + 1) + ' / ' + next.length);
  }
  function track() {
    const value = drag.current,
      container = list.current;
    if (!value || !container) return;
    const bounds = container.getBoundingClientRect();
    if (value.y < bounds.top + 30) container.scrollTop -= 10;
    else if (value.y > bounds.bottom - 30) container.scrollTop += 10;
    const rows = Array.from(container.children);
    let nearest = 0,
      distance = Infinity;
    rows.forEach((row, index) => {
      const box = row.getBoundingClientRect(),
        gap = Math.abs(value.y - (box.top + box.height / 2));
      if (gap < distance) {
        nearest = index;
        distance = gap;
      }
    });
    move(current.current.groups.indexOf(value.group), nearest);
    frame.current = requestAnimationFrame(track);
  }
  function finish(cancel = false) {
    const value = drag.current;
    if (!value) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (cancel) {
      current.current.groups = value.initial;
      current.current.onChange(value.initial);
      setAnnouncement(tr('已取消拖拽'));
    }
    setActive(null);
    if (list.current?.hasPointerCapture(value.pointer))
      list.current.releasePointerCapture(value.pointer);
  }
  function start(e: PointerEvent<HTMLButtonElement>, group: string) {
    if (busy || !e.isPrimary || e.button !== 0 || drag.current || groups.length < 2) return;
    e.preventDefault();
    e.currentTarget.focus();
    drag.current = { group, pointer: e.pointerId, initial: [...groups], y: e.clientY };
    list.current?.setPointerCapture(e.pointerId);
    setActive(group);
    frame.current = requestAnimationFrame(track);
  }
  return (
    <>
      <p id={help} className="muted group-order-help">
        {tr('拖动手柄调整顺序，也可聚焦手柄后使用方向键。保存后同步到账户页和选择弹窗。')}
      </p>
      <ol
        ref={list}
        className={'group-order-list' + (active !== null ? ' is-dragging' : '')}
        aria-label={tr('账户分组顺序')}
        onPointerMove={(e) => {
          if (drag.current?.pointer === e.pointerId) drag.current.y = e.clientY;
        }}
        onPointerUp={(e) => {
          if (drag.current?.pointer === e.pointerId) finish();
        }}
        onPointerCancel={(e) => {
          if (drag.current?.pointer === e.pointerId) finish(true);
        }}
        onLostPointerCapture={(e) => {
          if (drag.current?.pointer === e.pointerId) finish(true);
        }}
      >
        {groups.map((group, index) => (
          <li key={group} className={active === group ? 'drag-active' : undefined}>
            <button
              type="button"
              className="group-drag-handle"
              aria-label={tr('拖动分组') + ' ' + (group || tr('未分组'))}
              aria-describedby={help}
              disabled={busy || groups.length < 2}
              onPointerDown={(e) => start(e, group)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && drag.current) {
                  e.preventDefault();
                  finish(true);
                  return;
                }
                if (drag.current || busy) return;
                const targets: Record<string, number> = {
                  ArrowUp: index - 1,
                  ArrowDown: index + 1,
                  Home: 0,
                  End: groups.length - 1,
                };
                if (e.key in targets) {
                  e.preventDefault();
                  move(index, targets[e.key]);
                }
              }}
            >
              <GripVertical size={20} aria-hidden="true" />
            </button>
            <span className="group-order-name">{group || tr('未分组')}</span>
            <span className="group-order-index" aria-hidden="true">
              {index + 1}
            </span>
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
