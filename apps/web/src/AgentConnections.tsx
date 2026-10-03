import { useEffect, useState } from 'react';
import { api } from './api';

type Connection = {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  clientId: string | null;
};
type Operation = { id: string; tool: string; status: string; expiresAt: string; createdAt: string };
type Management = {
  mcpUrl: string;
  mode: string;
  grants: Connection[];
  operations: Operation[];
  calls: { id: string; tool: string; status: string; createdAt: string }[];
};
type Preview = {
  operationId: string;
  tool: string;
  status: string;
  description: string;
  impact: unknown;
  web?: string;
  sensitive: boolean;
  result?: unknown;
};
type Consent = {
  id: string;
  name: string;
  scopes: string[];
  redirectUri: string;
  resource: string;
};
export function AgentConnections() {
  const [data, setData] = useState<Management | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [token, setToken] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [consent, setConsent] = useState<Consent | null>(null),
    [busy, setBusy] = useState(false);
  const load = async () => setData(await api<Management>('/agent'));
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };
  const show = async (id: string) => setPreview(await api<Preview>('/agent/operations/' + id));
  useEffect(() => {
    void act(async () => {
      await load();
      const params = new URLSearchParams(location.search);
      const authorization = params.get('agent_authorization'),
        operation = params.get('agent_operation');
      if (authorization) setConsent(await api<Consent>('/agent/authorizations/' + authorization));
      if (operation) await show(operation);
    });
  }, []);
  return (
    <section className="panel agent-panel">
      <h2>连接 Agent</h2>
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <p>远程 MCP 地址</p>
          <code className="agent-address">{data.mcpUrl}</code>
          <button
            className="secondary"
            type="button"
            onClick={() => void navigator.clipboard.writeText(data.mcpUrl)}
          >
            复制地址
          </button>
          <p className="muted">
            支持 Streamable HTTP。OAuth 客户端使用此地址发现授权信息，浏览器登录 WorthPath
            后审核连接名称、回调地址和权限。访问令牌每小时过期，刷新令牌最多 30
            天并在使用时轮换。个人令牌适用于支持 Bearer 头的客户端。
          </p>
          <p className="muted">
            已验证客户端：官方 TypeScript SDK 1.31.0（OAuth / Bearer）。其他 Agent
            尚未验证；不会保证任意客户端兼容。
          </p>
          <details>
            <summary>官方 SDK 的已验证接入配置</summary>
            <pre>{`new StreamableHTTPClientTransport(new URL(${JSON.stringify(data.mcpUrl)}), {\n  requestInit: { headers: { Authorization: 'Bearer ' + process.env.MCP_ACCESS_TOKEN } }\n});`}</pre>
            <button
              className="secondary"
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  `$env:MCP_SERVER_URL=${JSON.stringify(data.mcpUrl)}\npnpm --filter @worthpath/api mcp:probe`,
                )
              }
            >
              复制本项目诊断客户端命令
            </button>
            <p className="muted">
              先在终端设置 MCP_ACCESS_TOKEN，再运行复制的命令。完整 OAuth 示例及安全存储说明见
              docs/mcp.md；此配置仅针对官方 SDK 1.31.0。
            </p>
          </details>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                form = e.currentTarget;
              void act(async () => {
                await api('/agent/policy', 'PUT', {
                  mode: f.get('mode'),
                  password: f.get('password'),
                });
                form.reset();
                setMessage('写入策略已保存');
              });
            }}
          >
            <h3>写入策略</h3>
            <select name="mode" defaultValue={data.mode} key={data.mode}>
              <option value="readonly">只读</option>
              <option value="draft">创建草稿，由网页确认</option>
              <option value="direct">已授权 write 的连接可直接普通写入</option>
            </select>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="当前密码"
            />
            <button className="secondary" disabled={busy}>
              保存策略
            </button>
          </form>
          <h3>OAuth 授权与个人令牌</h3>
          <p className="muted">
            read 查询；draft 创建草稿；write 按写入策略执行普通写入；sensitive
            发起敏感操作，仍须网页验证密码。令牌到期可新建并撤销旧令牌。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form);
              void act(async () => {
                const v = await api<{ token: string }>('/agent/tokens', 'POST', {
                  name: f.get('name'),
                  days: Number(f.get('days')),
                  password: f.get('password'),
                  scopes: f.getAll('scope'),
                });
                setToken(v.token);
                form.reset();
              });
            }}
          >
            <input name="name" required maxLength={100} placeholder="连接名称" />
            <input
              name="days"
              type="number"
              min={1}
              max={90}
              defaultValue={30}
              required
              aria-label="有效天数"
            />
            {['read', 'draft', 'write', 'sensitive'].map((s) => (
              <label key={s}>
                <input
                  type="checkbox"
                  name="scope"
                  value={s}
                  defaultChecked={s === 'read'}
                  required={s === 'read'}
                />
                {s}
              </label>
            ))}
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="当前密码"
            />
            <button className="secondary" disabled={busy}>
              创建个人令牌
            </button>
          </form>
          {token && (
            <div role="status">
              <p>完整令牌仅显示这一次，请妥善保存。</p>
              <code className="agent-address">{token}</code>
              <button
                className="secondary"
                type="button"
                onClick={() => void navigator.clipboard.writeText(token)}
              >
                复制令牌
              </button>
              <button className="secondary" type="button" onClick={() => setToken('')}>
                隐藏令牌
              </button>
            </div>
          )}
          <h3>已授权连接（最近 100 条）</h3>
          {data.grants.map((g) => (
            <div key={g.id} className="agent-row">
              <span>
                {g.name} · {g.clientId ? 'OAuth' : '个人令牌'} · {g.scopes.join(', ')} ·{' '}
                {new Date(g.expiresAt).toLocaleString()} · {g.revokedAt ? '已撤销' : ''}
              </span>
              {!g.revokedAt && (
                <button
                  className="secondary"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void act(async () => {
                      await api('/agent/connections/' + g.id, 'DELETE');
                      setMessage('连接已撤销');
                    })
                  }
                >
                  撤销
                </button>
              )}
            </div>
          ))}
          <h3>待确认及最近操作（最近 100 条）</h3>
          <button
            className="secondary"
            disabled={busy}
            type="button"
            onClick={() => void act(load)}
          >
            刷新状态
          </button>
          {data.operations.map((o) => (
            <div key={o.id} className="agent-row">
              <span>
                {o.tool} ·{' '}
                {o.status === 'pending' && new Date(o.expiresAt) < new Date()
                  ? 'expired'
                  : o.status}{' '}
                · {new Date(o.createdAt).toLocaleString()}
              </span>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => void act(() => show(o.id))}
              >
                查看影响和结果
              </button>
            </div>
          ))}
          <h3>最近调用（不保存参数和敏感内容）</h3>
          {data.calls.map((c) => (
            <div key={c.id} className="agent-row">
              {c.tool} · {c.status} · {new Date(c.createdAt).toLocaleString()}
            </div>
          ))}
        </>
      )}
      {consent && (
        <div className="agent-confirm">
          <h3>审核 OAuth 连接</h3>
          <p>{consent.name}</p>
          <p>权限：{consent.scopes.join(', ')}</p>
          <p>资源：{consent.resource}</p>
          <p>回调地址：{consent.redirectUri}</p>
          <p className="muted">只批准你正在连接的客户端；请核对回调地址。</p>
          {[true, false].map((approve) => (
            <button
              className="secondary"
              disabled={busy}
              type="button"
              key={String(approve)}
              onClick={() =>
                void act(async () => {
                  const v = await api<{ redirect: string }>(
                    '/agent/authorizations/' + consent.id,
                    'POST',
                    { approve },
                  );
                  location.assign(v.redirect);
                })
              }
            >
              {approve ? '授权此连接' : '拒绝授权'}
            </button>
          ))}
        </div>
      )}
      {preview && (
        <div className="agent-confirm">
          <h3>
            {preview.tool} · {preview.status}
          </h3>
          <p>{preview.description}</p>
          <pre>{JSON.stringify(preview.impact, null, 2)}</pre>
          {preview.result !== undefined && <pre>{JSON.stringify(preview.result, null, 2)}</pre>}
          {preview.status === 'pending' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget),
                  form = e.currentTarget;
                void act(async () => {
                  await api('/agent/operations/' + preview.operationId, 'POST', {
                    approve: true,
                    ...(f.get('password') ? { password: f.get('password') } : {}),
                    ...(f.get('username') ? { username: f.get('username') } : {}),
                    ...(f.get('newPassword') ? { newPassword: f.get('newPassword') } : {}),
                    ...(f.get('confirmation') ? { confirmation: f.get('confirmation') } : {}),
                  });
                  form.reset();
                  await show(preview.operationId);
                  setMessage('操作已提交，Agent 可以查询最终结果');
                });
              }}
            >
              {preview.web === 'clear' && (
                <>
                  <a href="/api/backup" download>
                    先下载当前账号备份
                  </a>
                  <p>确认备份已保存后输入“确定清空”。</p>
                  <input name="confirmation" required placeholder="确定清空" />
                </>
              )}
              {preview.web === 'credentials' && (
                <>
                  <input name="username" placeholder="新账号（可选）" autoComplete="username" />
                  <input
                    name="newPassword"
                    type="password"
                    minLength={10}
                    maxLength={72}
                    placeholder="新密码（可选）"
                    autoComplete="new-password"
                  />
                </>
              )}
              {preview.sensitive && (
                <input
                  name="password"
                  type="password"
                  required
                  placeholder="当前密码"
                  autoComplete="current-password"
                />
              )}
              <button className="secondary" disabled={busy}>
                确认执行上述操作
              </button>
              <button
                className="secondary"
                disabled={busy}
                type="button"
                onClick={() =>
                  void act(async () => {
                    await api('/agent/operations/' + preview.operationId, 'POST', {
                      approve: false,
                    });
                    await show(preview.operationId);
                  })
                }
              >
                取消
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
