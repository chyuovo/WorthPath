import { t as tr } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconLibrary, iconUrl } from './IconLibrary';
export function IconPicker({ initialId }: { initialId?: string | null }) {
  const [id, setId] = useState(initialId || ''),
    [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLInputElement>('input[type=search]')?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
      }
      if (e.key === 'Tab') {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, summary',
          ) || []),
        ].filter((v) => v.offsetParent !== null);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && index <= 0) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && index === controls.length - 1) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }
    }
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      prior?.focus();
    };
  }, [open]);
  return (
    <div className="account-icon-field">
      <input type="hidden" name="iconId" value={id} />
      {id && <img src={iconUrl(id)} alt={tr('已选账户图标')} />}
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        {id ? tr('更换图标') : tr('选择图标')}
      </button>
      {id && (
        <button type="button" className="text" onClick={() => setId('')}>
          {tr('移除')}
        </button>
      )}
      {open &&
        createPortal(
          <div
            className="icon-picker-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div
              ref={dialog}
              className="icon-picker-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={tr('选择账户图标')}
            >
              <div className="panel-title">
                <h2>{tr('账户图标')}</h2>
                <button type="button" className="secondary" onClick={() => setOpen(false)}>
                  {tr('关闭图标选择')}
                </button>
              </div>
              <IconLibrary
                picker
                initialId={id}
                onSelect={(value) => {
                  setId(value);
                  setOpen(false);
                }}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
