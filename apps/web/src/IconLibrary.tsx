import { t as tr } from './i18n';
import { useEffect, useState, useRef } from 'react';
import { api } from './api';
import { useToast } from './Toast';
type Icon = { id: string; name: string; shared: boolean };
export const iconUrl = (id: string) => '/api/icons/' + encodeURIComponent(id) + '/image';
export function IconLibrary({
  initialId,
  picker = false,
  onSelect,
}: {
  initialId?: string | null;
  picker?: boolean;
  onSelect?: (id: string) => void;
}) {
  const [selected, select] = useState(initialId || ''),
    [q, search] = useState(''),
    [page, setPage] = useState(1),
    [items, setItems] = useState<Icon[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [name, setName] = useState(''),
    [shared, setShared] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [refresh, setRefresh] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  useToast(error, 'error');
  useToast(notice, 'success');
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api<{ items: Icon[]; total: number }>(
        '/icons?q=' + encodeURIComponent(q) + '&page=' + page,
      )
        .then((v) => {
          if (active) {
            setItems(v.items);
            setTotal(v.total);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [q, page, refresh]);
  async function upload() {
    const image = file.current?.files?.[0];
    setError('');
    setNotice('');
    if (!image) {
      setError(tr('请选择图片'));
      return;
    }
    if (!name.trim() || (shared && (!/\p{Script=Han}/u.test(name) || !confirmed))) {
      setError(tr('请填写名称；共享图标须含中文并确认公开'));
      return;
    }
    if (image.size > 2 * 1024 * 1024) {
      setError(tr('图片不能超过 2 MB'));
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', image);
      form.append('name', name);
      form.append('shared', String(shared));
      if (shared) form.append('confirmed', 'true');
      const res = await fetch('/api/icons/upload', {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      const v = await res.json();
      if (!res.ok) throw Error(v.message || tr('上传失败'));
      if (picker) select(v.id);
      setNotice(
        shared
          ? tr('图标已发布，所有登录用户均可搜索和使用')
          : tr('图标已存入我的图标，仅自己可见'),
      );
      setName('');
      setConfirmed(false);
      if (file.current) file.current.value = '';
      search('');
      setPage(1);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="icon-library"
      aria-label={tr('账户图标库')}
      onKeyDown={(e) => {
        if (
          e.key === 'Enter' &&
          e.target instanceof HTMLInputElement &&
          e.target.type !== 'checkbox'
        )
          e.preventDefault();
      }}
    >
      <h2>{picker ? tr('选择账户图标') : tr('图标库')}</h2>
      <p className="muted">
        {tr('搜索共享图标和我的图标，选择后可在多个账户复用。直接上传默认仅自己可见。')}
      </p>
      {picker && (
        <div className="icon-selection">
          {selected ? (
            <>
              <img src={iconUrl(selected)} alt={tr('当前账户图标')} />
              <span>{tr('已选择图标')}</span>
              <button type="button" className="text" onClick={() => select('')}>
                {tr('移除图标')}
              </button>
            </>
          ) : (
            <span>{tr('使用默认账户图标')}</span>
          )}
        </div>
      )}
      <label>
        {tr('搜索图标名称')}
        <input
          type="search"
          value={q}
          placeholder={tr('例如：工商银行、支付宝')}
          onChange={(e) => {
            search(e.target.value);
            setPage(1);
          }}
          maxLength={100}
        />
      </label>
      {loading ? (
        <p role="status">{tr('正在加载图标…')}</p>
      ) : (
        <>
          <div className="icon-grid">
            {items.map((i) =>
              picker ? (
                <button
                  type="button"
                  className={'icon-option' + (selected === i.id ? ' selected' : '')}
                  key={i.id}
                  aria-pressed={picker ? selected === i.id : undefined}
                  onClick={() => select(i.id)}
                >
                  <img src={iconUrl(i.id)} alt="" loading="lazy" />
                  <span>{i.name}</span>
                  <small>{i.shared ? tr('共享') : tr('仅自己')}</small>
                </button>
              ) : (
                <div className="icon-option" key={i.id}>
                  <img src={iconUrl(i.id)} alt="" loading="lazy" />
                  <span>{i.name}</span>
                  <small>{i.shared ? tr('共享') : tr('仅自己')}</small>
                </div>
              ),
            )}
          </div>
          {!items.length && <p>{tr('没有匹配图标，可以在下方上传。')}</p>}
          <div className="icon-pagination">
            <span>
              {tr('共')}
              {total} {tr('个图标')}
            </span>
            <button
              className="secondary"
              type="button"
              disabled={page === 1}
              onClick={() => setPage((n) => n - 1)}
            >
              {tr('上一页')}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={page * 60 >= total}
              onClick={() => setPage((n) => n + 1)}
            >
              {tr('下一页')}
            </button>
          </div>
        </>
      )}
      {onSelect && (
        <button type="button" className="primary" onClick={() => onSelect(selected)}>
          {tr('应用所选图标')}
        </button>
      )}
      <details className="icon-upload">
        <summary>{tr('上传我的图标 / 导入共享图标')}</summary>
        <label>
          {tr('图标名称（共享时必须含中文）')}
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </label>
        <label>
          {tr('图片文件（PNG、JPG、WebP，最大 2 MB）')}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" />
        </label>
        <label className="check-line">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => {
              setShared(e.target.checked);
              setConfirmed(false);
            }}
          />
          {tr('发布到共享图标库')}
        </label>
        {shared && (
          <label className="check-line">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {tr('确认此图片可公开，所有用户均可搜索并复用；已发布图标会保留供他人使用')}
          </label>
        )}
        <button className="primary" type="button" disabled={busy} onClick={() => void upload()}>
          {busy ? tr('正在上传…') : shared ? tr('导入共享图标') : tr('上传私有图标')}
        </button>
      </details>
    </section>
  );
}
