import { t as tr } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconLibrary, iconUrl } from './IconLibrary';
export function IconPicker({ initialId }: { initialId?: string | null }) {
  const [id, setId] = useState(initialId || ''),
    [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input[type=search]')?.focus();
    return () => {
      element?.close();
      if (prior?.isConnected) prior.focus();
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
          <dialog
            ref={dialog}
            aria-label={tr('选择账户图标')}
            aria-modal="true"
            onCancel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }}
            className="icon-picker-backdrop native-icon-picker"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className="icon-picker-dialog">
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
          </dialog>,
          document.body,
        )}
    </div>
  );
}
