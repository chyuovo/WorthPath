import { useId, useRef, useState, useContext } from 'react';
import { type Position, money, positionAmount } from './api';
import { t as tr } from './i18n';
import { iconUrl } from './IconLibrary';
import { GroupOrderContext } from './GroupOrderContext';
import { orderedGroups } from './group-order';
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
  const order = useContext(GroupOrderContext);
  const groups = grouped
    ? orderedGroups(
        rows.map((p) => p.groupName || ''),
        order,
      )
    : ['全部账户'];
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
            <h3>{grouped ? group || tr('未分组') : tr('全部账户')}</h3>
            {rows
              .filter((p) => !grouped || (p.groupName || '') === group)
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
                    <small
                      className={positionAmount(p).startsWith('-') ? 'danger-text' : 'income-text'}
                    >
                      {money(positionAmount(p), p.currency)}
                    </small>
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
