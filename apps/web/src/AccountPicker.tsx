import { useId, useRef, useState } from 'react';
import { type Position, money, positionAmount } from './api';
import { t as tr } from './i18n';
import { iconUrl } from './IconLibrary';
export function AccountPicker({
  name,
  accounts,
  value,
  onChange,
  excludeId,
}: {
  name: string;
  accounts: Position[];
  value: string;
  onChange: (id: string) => void;
  excludeId?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  const [grouped, setGrouped] = useState(true),
    [query, setQuery] = useState('');
  const selected = accounts.find((p) => p.id === value);
  const rows = accounts.filter(
    (p) =>
      p.id !== excludeId &&
      `${p.name} ${p.groupName || ''} ${p.currency}`.toLowerCase().includes(query.toLowerCase()),
  );
  const groups = grouped ? [...new Set(rows.map((p) => p.groupName || '未分组'))] : ['全部账户'];
  return (
    <div className="account-picker">
      <input name={name} type="hidden" value={value} />
      <button
        className="secondary picker-trigger"
        type="button"
        onClick={() => dialog.current?.showModal()}
      >
        {selected
          ? `${selected.name} · ${money(positionAmount(selected), selected.currency)}`
          : tr('选择账户')}
      </button>
      <dialog ref={dialog} className="picker-dialog" aria-labelledby={title}>
        <div className="panel-title">
          <h2 id={title}>{tr('选择账户')}</h2>
          <button type="button" onClick={() => dialog.current?.close()} aria-label={tr('关闭')}>
            ×
          </button>
        </div>
        <input
          placeholder={tr('搜索账户、分组或币种')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="actions">
          <button
            className="secondary picker-view-toggle"
            type="button"
            onClick={() => setGrouped(!grouped)}
          >
            {tr(grouped ? '显示全部账户' : '按分组显示')} <span aria-hidden="true">⇄</span>
          </button>
        </div>
        {groups.map((group) => (
          <section key={group}>
            <h3>{tr(group)}</h3>
            {rows
              .filter((p) => !grouped || (p.groupName || '未分组') === group)
              .map((p) => (
                <button
                  type="button"
                  className="picker-option"
                  key={p.id}
                  onClick={() => {
                    onChange(p.id);
                    dialog.current?.close();
                  }}
                >
                  {p.iconId && <img src={iconUrl(p.iconId)} alt="" />}
                  <span>
                    {p.name}
                    <small>{money(positionAmount(p), p.currency)}</small>
                  </span>
                  {p.id === value && <span>✓</span>}
                </button>
              ))}
          </section>
        ))}
        {!rows.length && <p>{tr('没有符合条件的账户')}</p>}
      </dialog>
    </div>
  );
}
