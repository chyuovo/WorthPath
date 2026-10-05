import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from './api';
import { t as tr } from './i18n';
type Account = {
  id: string;
  username: string;
  role: string;
  banned: boolean;
  mustChangePassword: boolean;
};
const roleLabels: Record<string, string> = {
  admin: '管理员',
  user: '普通用户',
  readonly: '只读用户',
};
export function AdminPanel({ user, report }: { user: User; report: (e: unknown) => void }) {
  const [items, setItems] = useState<Account[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState<Account | null>(null);
  const [confirmation, setConfirmation] = useState('');
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api<{ items: Account[]; total: number }>('/admin/users?limit=50&offset=' + offset)
      .then((data) => {
        if (!cancelled) {
          setItems(data.items);
          setTotal(data.total);
        }
      })
      .catch((e) => {
        if (!cancelled) report(e);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [offset, version]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = new FormData(form);
    setBusy(true);
    try {
      await api('/admin/users', 'POST', {
        username: data.get('username'),
        password: data.get('password'),
        role: data.get('role'),
      });
      form.reset();
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function change(account: Account, data: { role?: string; banned?: boolean }) {
    setBusy(true);
    try {
      await api('/admin/users/' + account.id, 'PATCH', data);
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!deleting) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api('/admin/users/' + deleting.id, 'DELETE', {
        confirmationUsername: confirmation,
        currentPassword: f.get('currentPassword'),
      });
      setDeleting(null);
      setConfirmation('');
      setOffset(0);
      setVersion((v) => v + 1);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="admin-panel">
      <section className="panel">
        <h2>{tr('添加账号')}</h2>
        <p className="muted">{tr('新账号首次登录必须修改初始密码。')}</p>
        <form onSubmit={create} className="admin-create">
          <label className="field">
            <span>{tr('账号')}</span>
            <input name="username" required minLength={3} maxLength={64} autoComplete="off" />
          </label>
          <label className="field">
            <span>{tr('初始密码')}</span>
            <input
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={72}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>{tr('账号权限')}</span>
            <select name="role" defaultValue="user">
              {Object.entries(roleLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {tr(label)}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy}>
            {tr('添加账号')}
          </button>
        </form>
        <p className="muted">
          {tr('管理员管理账号；普通用户可管理自己的数据；只读用户可查询数据并修改自己的登录密码。')}
        </p>
      </section>
      <section className="panel">
        <h2>
          {tr('账号管理')} · {total}
        </h2>
        <p className="muted">
          {tr('修改权限或封禁后，该账号的登录会话与 MCP 授权会撤销，需要重新登录或授权。')}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{tr('账号')}</th>
                <th>{tr('账号权限')}</th>
                <th>{tr('状态')}</th>
                <th>{tr('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.username}</strong>
                    {account.id === user.id && <small> · {tr('当前账号')}</small>}
                  </td>
                  <td>
                    <select
                      aria-label={account.username + ' ' + tr('账号权限')}
                      value={account.role}
                      disabled={busy || account.id === user.id}
                      onChange={(e) => void change(account, { role: e.target.value })}
                    >
                      {Object.entries(roleLabels).map(([v, label]) => (
                        <option key={v} value={v}>
                          {tr(label)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {account.banned
                      ? tr('已封禁')
                      : account.mustChangePassword
                        ? tr('待首次改密')
                        : tr('正常')}
                  </td>
                  <td>
                    <button
                      className={account.banned ? 'secondary' : 'danger'}
                      disabled={busy || account.id === user.id}
                      onClick={() => void change(account, { banned: !account.banned })}
                    >
                      {account.banned ? tr('解除封禁') : tr('封禁账号')}
                    </button>
                    {account.username === 'admin' &&
                      account.role === 'admin' &&
                      account.id !== user.id && (
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            setDeleting(account);
                            setConfirmation('');
                          }}
                        >
                          {tr('删除默认 admin')}
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={busy || offset === 0}
            onClick={() => setOffset((v) => Math.max(0, v - 50))}
          >
            {tr('上一页')}
          </button>
          <button
            className="secondary"
            disabled={busy || offset + 50 >= total}
            onClick={() => setOffset((v) => v + 50)}
          >
            {tr('下一页')}
          </button>
        </div>
      </section>
      {deleting && (
        <div className="veil">
          <section className="modal" role="dialog" aria-modal="true" aria-label={tr('删除账号')}>
            <h2>
              {tr('删除账号')} · {deleting.username}
            </h2>
            <p className="danger-text">
              {tr(
                '此操作不可撤销，将删除该账号及其全部财务数据、私有图标、登录会话和 MCP 授权；已发布的共享图标保留。请先由该账号用户保存需要的备份。',
              )}
            </p>
            <p className="muted">
              {tr(
                '仅允许删除默认 admin 账号；其他账号禁止删除。必须保留另一位已完成改密且未封禁的管理员，不能删除当前登录账号。',
              )}
            </p>
            <form onSubmit={remove}>
              <label className="field">
                <span>{tr('输入要删除的账号名称')}</span>
                <input
                  required
                  autoComplete="off"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{tr('验证当前管理员密码')}</span>
                <input
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                  maxLength={72}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  {tr('取消')}
                </button>
                <button className="danger" disabled={busy || confirmation !== deleting.username}>
                  {tr('永久删除账号')}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
export function FirstPassword({
  changed,
  logout,
  report,
}: {
  changed: (u: User) => void;
  logout: () => void;
  report: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('repeatPassword')) {
      report(new Error(tr('两次输入的新密码不一致')));
      return;
    }
    setBusy(true);
    try {
      await api('/auth/credentials', 'PATCH', {
        currentPassword: f.get('currentPassword'),
        newPassword: f.get('newPassword'),
      });
      changed(await api<User>('/auth/me'));
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="first-password">
      <section className="panel">
        <h1>{tr('首次登录，请修改密码')}</h1>
        <p className="muted">
          {tr('设置与初始密码不同的新密码后，即可进入系统。新密码至少 10 个字符，最多 72 字节。')}
        </p>
        <form onSubmit={submit}>
          <label className="field">
            <span>{tr('当前密码')}</span>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={72}
            />
          </label>
          <label className="field">
            <span>{tr('新密码')}</span>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={72}
            />
          </label>
          <label className="field">
            <span>{tr('确认新密码')}</span>
            <input
              name="repeatPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              maxLength={72}
            />
          </label>
          <button className="primary full" disabled={busy}>
            {tr('修改密码并进入')}
          </button>
        </form>
        <button className="text" disabled={busy} onClick={logout}>
          {tr('退出登录')}
        </button>
      </section>
    </main>
  );
}
