import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t as tr } from './i18n';
type Kind = 'success' | 'error';
type Notice = { id: number; message: string; kind: Kind };
let sequence = 0;
const listeners = new Set<(notice: Notice) => void>();
export function showToast(message: string, kind: Kind) {
  if (message) {
    const notice = { id: ++sequence, message, kind };
    listeners.forEach((fn) => fn(notice));
  }
}
export function useToast(message: string, kind: Kind) {
  useEffect(() => {
    showToast(message, kind);
  }, [message, kind]);
}
function ToastItem({ notice, remove }: { notice: Notice; remove: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const dismiss = () => {
    if (document.documentElement.dataset.input === 'keyboard') remove(notice.id);
    else setExiting(true);
  };
  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), notice.kind === 'error' ? 12000 : 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => remove(notice.id), 120);
    return () => clearTimeout(timer);
  }, [exiting, notice.id, remove]);
  return (
    <div
      className={'toast ' + notice.kind}
      data-ending={exiting || undefined}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-symbol" aria-hidden="true">
        {notice.kind === 'error' ? '!' : '✓'}
      </span>
      <p>{tr(notice.message)}</p>
      <button type="button" className="icon" aria-label={tr('关闭')} onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
export function ToastViewport() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement>(document.body);
  useEffect(() => {
    // A native modal makes content outside it inert. Keep the live notification
    // and its dismiss control within the current dialog, while the popover
    // renders them above the dialog in the browser's top layer.
    const updateHost = () => {
      const dialogs = document.querySelectorAll<HTMLElement>(
        'dialog[open], [role="dialog"][aria-modal="true"]',
      );
      const next = dialogs.item(dialogs.length - 1) ?? document.body;
      setHost((current) => (current === next ? current : next));
    };
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
    updateHost();
    return () => observer.disconnect();
  }, []);
  const remove = useRef((id: number) =>
    setNotices((rows) => rows.filter((n) => n.id !== id)),
  ).current;
  useEffect(() => {
    const receive = (n: Notice) =>
      setNotices((rows) => [...rows.filter((v) => v.message !== n.message).slice(-2), n]);
    listeners.add(receive);
    return () => {
      listeners.delete(receive);
    };
  }, []);
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (notices.length) {
      el.hidePopover?.();
      el.showPopover?.();
    } else el.hidePopover?.();
  }, [notices, host]);
  return createPortal(
    <div ref={panel} popover="manual" className="toast-viewport" aria-label={tr('操作提示')}>
      {notices.map((notice) => (
        <ToastItem key={notice.id} notice={notice} remove={remove} />
      ))}
    </div>,
    host,
  );
}
