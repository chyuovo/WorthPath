import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { t } from './i18n';

export function PullToRefresh({
  refreshing,
  refresh,
}: {
  refreshing: boolean;
  refresh: () => Promise<void>;
}) {
  const [distance, setDistance] = useState(0);
  const action = useRef({ refreshing, refresh });
  action.current = { refreshing, refresh };
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    let pulled = 0;
    let pending = false;
    const reset = () => {
      start = null;
      pulled = 0;
      setDistance(0);
    };
    const down = (e: TouchEvent) => {
      reset();
      if (
        pending ||
        action.current.refreshing ||
        e.touches.length !== 1 ||
        window.scrollY > 0 ||
        !matchMedia('(max-width: 700px)').matches
      )
        return;
      const target = e.target as HTMLElement;
      if (
        !target.closest('main') ||
        target.closest('button, input, select, textarea, a, dialog, .modal-backdrop')
      )
        return;
      for (let el: HTMLElement | null = target; el && el !== document.body; el = el.parentElement) {
        if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))
          return;
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const move = (e: TouchEvent) => {
      if (!start) return;
      if (e.touches.length !== 1 || window.scrollY > 0) {
        reset();
        return;
      }
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (dy < 0 || Math.abs(dx) > dy) {
        reset();
        return;
      }
      if (dy > 8) {
        if (e.cancelable) e.preventDefault();
        pulled = Math.min(100, dy * 0.5);
        setDistance(pulled);
      }
    };
    const up = () => {
      const ready = pulled >= 60;
      reset();
      if (ready && !pending && !action.current.refreshing) {
        pending = true;
        void action.current.refresh().finally(() => {
          pending = false;
        });
      }
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up);
    document.addEventListener('touchcancel', reset);
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', reset);
    };
  }, []);
  return (
    <div className="pull-refresh" role="status" hidden={!distance && !refreshing}>
      <RefreshCw size={18} className={refreshing ? 'refresh-spinning' : ''} />
      {refreshing ? t('正在刷新数据…') : distance >= 60 ? t('松开刷新') : t('下拉刷新')}
    </div>
  );
}
