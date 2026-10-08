import { useLayoutEffect, useRef, type ReactNode } from 'react';

type Item = { key: string; label: string; icon: ReactNode; select: () => void };
// Native pointer tracking: preserve the grab offset and never animate a gesture.
export function PrimaryNav({
  items,
  active,
  label,
}: {
  items: Item[];
  active: string;
  label: string;
}) {
  const nav = useRef<HTMLElement>(null);
  const lens = useRef<HTMLSpanElement>(null);
  const drag = useRef<{
    id: number;
    startX: number;
    startY: number;
    left: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const buttons = () =>
    Array.from(nav.current?.querySelectorAll<HTMLButtonElement>('button') || []);
  const place = (left: number, width: number, height: number) => {
    const el = lens.current;
    if (el) {
      el.style.transform = 'translateX(' + left + 'px)';
      el.style.width = width + 'px';
      el.style.height = height + 'px';
    }
  };
  const reset = () => {
    const button = buttons().find((b) => b.dataset.key === active);
    if (button) place(button.offsetLeft, button.offsetWidth, button.offsetHeight);
    nav.current?.removeAttribute('data-dragging');
    buttons().forEach((b) => b.removeAttribute('data-preview'));
  };
  useLayoutEffect(() => {
    reset();
    const observer = new ResizeObserver(() => {
      if (!drag.current) reset();
    });
    if (nav.current) observer.observe(nav.current);
    return () => observer.disconnect();
  }, [active, items.length]);
  const finish = (cancelled: boolean) => {
    const gesture = drag.current;
    drag.current = null;
    if (gesture?.moved && !cancelled) {
      const preview = buttons().find((b) => b.dataset.preview === 'true');
      const item = items.find((i) => i.key === preview?.dataset.key);
      suppressClick.current = true;
      item?.select();
    }
    reset();
  };
  return (
    <nav
      ref={nav}
      className="primary-nav"
      aria-label={label}
      style={{ gridTemplateColumns: 'repeat(' + items.length + ', minmax(0, 1fr))' }}
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0 || !matchMedia('(max-width: 700px)').matches) return;
        suppressClick.current = false;
        const current = buttons().find((b) => b.dataset.key === active);
        if (current)
          drag.current = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            left: current.offsetLeft,
            moved: false,
          };
      }}
      onPointerMove={(e) => {
        const g = drag.current,
          root = nav.current;
        if (!g || g.id !== e.pointerId || !root) return;
        const dx = e.clientX - g.startX;
        if (!g.moved) {
          if (Math.abs(e.clientY - g.startY) > Math.abs(dx) && Math.abs(e.clientY - g.startY) > 8) {
            finish(true);
            return;
          }
          if (Math.abs(dx) < 8) return;
          g.moved = true;
          root.setPointerCapture(e.pointerId);
          root.dataset.dragging = 'true';
        }
        const all = buttons(),
          first = all[0],
          last = all[all.length - 1];
        if (!first || !last) return;
        const left = Math.max(first.offsetLeft, Math.min(last.offsetLeft, g.left + dx));
        place(left, first.offsetWidth, first.offsetHeight);
        const center = left + first.offsetWidth / 2;
        const closest = all.reduce((best, b) =>
          Math.abs(b.offsetLeft + b.offsetWidth / 2 - center) <
          Math.abs(best.offsetLeft + best.offsetWidth / 2 - center)
            ? b
            : best,
        );
        all.forEach((b) => {
          b.dataset.preview = String(b === closest);
        });
      }}
      onPointerUp={(e) => {
        if (drag.current?.id === e.pointerId) finish(false);
      }}
      onPointerCancel={() => finish(true)}
      onLostPointerCapture={(e) => {
        if (e.target === e.currentTarget && drag.current) finish(true);
      }}
      onClickCapture={(e) => {
        if (suppressClick.current && e.detail > 0) {
          e.preventDefault();
          e.stopPropagation();
          suppressClick.current = false;
        }
      }}
    >
      <span ref={lens} className="nav-glass-lens" aria-hidden="true" />
      {items.map((item) => (
        <button
          key={item.key}
          data-key={item.key}
          className={active === item.key ? 'active' : ''}
          aria-current={active === item.key ? 'page' : undefined}
          onClick={item.select}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
