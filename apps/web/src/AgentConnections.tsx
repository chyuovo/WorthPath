import { useEffect, useState } from 'react';
import { api } from './api';
import { showToast, useToast } from './Toast';

type Connection = {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  clientId: string | null;
};
type Operation = { id: string; tool: string; status: string; expiresAt: string; createdAt: string };
type Management = {
  capabilities: { name: string; description: string; scope: string; destructive?: boolean }[];
  mcpUrl: string;
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
  result?: unknown;
};
type Consent = {
  id: string;
  name: string;
  scopes: string[];
  redirectUri: string;
  resource: string;
};
const scopeDetails = [
  {
    id: 'read',
    title: '只读查询',
    summary: '查看账目和状态，不修改金额',
    detail:
      '查询账户、资产、债务、关联、余额和历史、净资产趋势、日历、计划与执行记录、汇率、贵金属报价、设置和图标；读取本连接操作及文件状态。隐藏账户默认不允许读取，须额外授权。',
  },
  {
    id: 'draft',
    title: '创建草稿',
    summary: '提出普通修改，等待你在网页确认',
    detail:
      '可提出创建或编辑持仓、余额/估值更新、转账和借贷还款、历史更正/删除、计划管理、分组排序、设置修改及私有图标上传等普通操作。草稿明确保存参数和影响，10 分钟过期；不会直接入账。',
  },
  {
    id: 'write',
    title: '普通写入',
    summary: '普通修改直接执行',
    detail:
      '覆盖普通修改和创建草稿的操作。授予 write 后普通修改直接执行；draft 等待网页确认；read 拒绝修改。归档、历史删除和转账撤销也属于普通写入，请按所需范围授权。',
  },
];
const durationOptions = [
  ['1', '1 天'],
  ['3', '3 天'],
  ['7', '7 天'],
  ['30', '30 天'],
  ['365', '1 年（365 天）'],
  ['permanent', '永久（可撤销）'],
];
const capabilityGroups = [
  {
    title: '账户、资产与债务',
    pattern: /^(positions_|position_|balance_|metal_holding|metal_configure|metal_value)/,
    summary: '创建和管理持仓、分组、图标、归档与计入开关；贵金属按克数管理。',
  },
  {
    title: '资金变化与历史',
    pattern: /^(transfer|loan|debt|history|revision)/,
    summary: '转账、借入借出、收款还款、记录更正、删除与撤销，沿用金额重算规则。',
  },
  {
    title: '统计、汇率与计划',
    pattern: /^(overview|trend|calendar|schedule|rates|metals_)/,
    summary: '净资产与趋势、日历筛选、定时计划及执行记录、汇率和参考报价。',
  },
  {
    title: '设置与私有图标',
    pattern: /^(settings|icons|icon_|backup|import|data_|credentials|hidden|file_)/,
    summary: '非安全类用户设置、私有图库上传与读取；敏感操作仅在网站执行。',
  },
];
function instructions(url: string) {
  return [
    '以下是配置 MCP 连接后的操作说明，不会自动添加连接或授予工具。若本会话没有 WorthPath 工具，请先告知我，并指导我在客户端配置连接；不要仅凭网址或聊天中的令牌声称已连接。',
    '请使用已连接的 WorthPath MCP 服务处理我的资产与负债，服务地址：' + url,
    '接入使用 Streamable HTTP。支持 OAuth 的客户端使用该地址发现授权服务，并由我在 WorthPath 网页登录授权；个人令牌仅用于明确支持 Bearer 认证的客户端，按其文档配置环境变量或凭据存储。不要假设客户端有自定义请求头界面，不要让我把密码或令牌粘贴到对话中。localhost 仅适用于 MCP 请求在 WorthPath 所在电脑执行的客户端；云端客户端需要可访问的 HTTPS 地址。',
    '先 tools/list 发现工具，调用 connection_info 核对权限：read 只读，draft 创建待网页确认的草稿，write 直接普通写入。隐藏账户读写以连接附加授权为准。',
    '查询：用 positions_list 搜索对象；遇到同名先让我选择稳定 ID；按 limit/offset 或 cursor 翻页。金额和克数使用十进制字符串，业务时间是 UTC+8 的 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。',
    '写入：先 state_get 取得 state，使用 expectedState 与唯一 idempotencyKey 调用所需工具。网络重试保持键和全部参数一致；状态冲突则重新查询并换键。不要把估值更新、转账、还款或负债变化互相替代。',
    '若返回 pending，把 confirmationUrl 给我，由我在网页审阅并确认；用 operation_get 轮询最终结果，不能用 confirmed=true 代替人类确认，也不能把草稿称为已完成。',
    'MCP 不提供密码修改、清空数据、备份导出恢复、共享图标发布及汇率或报价修改；这些流程由我在网站操作。',
    '我接下来会告诉你具体任务；在我提出任务前先不要修改数据。未发现的工具或未授予的权限请如实告知，不要猜测成功。',
  ].join('\n\n');
}

export function AgentConnections() {
  const [data, setData] = useState<Management | null>(null),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [token, setToken] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [consent, setConsent] = useState<Consent | null>(null),
    [busy, setBusy] = useState(false),
    [tokenPermission, setTokenPermission] = useState('read'),
    [tokenHiddenRead, setTokenHiddenRead] = useState(false),
    [tokenHiddenWrite, setTokenHiddenWrite] = useState(false),
    [agentView, setAgentView] = useState('connect'),
    [consentLevel, setConsentLevel] = useState('read'),
    [consentHiddenRead, setConsentHiddenRead] = useState(false),
    [consentHiddenWrite, setConsentHiddenWrite] = useState(false);
  useToast(error, 'error');
  useToast(message, 'success');
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
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label, 'success');
    } catch {
      showToast('复制失败，请从下方可选中文本手动复制', 'error');
    }
  };
  return (
    <section className="panel agent-panel">
      <div className="agent-heading">
        <div>
          <h2>连接 Agent</h2>
          <p className="muted">管理接入、操作权限和需要你确认的修改。</p>
        </div>
        {data && <span className="badge">{data.capabilities.length} 个工具 · 按连接授权</span>}
      </div>
      {data && (
        <div className="agent-layout">
          <nav className="agent-tabs agent-wide" aria-label="Agent 功能分区">
            {[
              ['connect', '开始连接'],
              ['tools', '权限与工具'],
              ['connections', '连接管理'],
              ['operations', '操作记录'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={agentView === value ? 'primary' : 'secondary'}
                aria-pressed={agentView === value}
                onClick={() => setAgentView(value)}
              >
                {label}
                {value === 'operations' &&
                data.operations.some(
                  (o) => o.status === 'pending' && new Date(o.expiresAt) > new Date(),
                )
                  ? ' · 待确认'
                  : ''}
              </button>
            ))}
          </nav>
          {agentView === 'connect' && (
            <>
              <section className="agent-card agent-wide">
                <h3>开始连接</h3>
                <p>远程 MCP 地址</p>
                <div className="agent-copy-row">
                  <code className="agent-address">{data.mcpUrl}</code>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void copy(data.mcpUrl, 'MCP 地址已复制')}
                  >
                    复制地址
                  </button>
                </div>
                <p className="muted">
                  先在客户端添加 MCP 连接并完成授权。复制下面的操作说明到聊天不会建立连接。
                </p>
                <details className="agent-details">
                  <summary>查看连接步骤</summary>
                  <p>
                    localhost 只适用于本机执行 MCP 请求的客户端；云端客户端需要可访问的 HTTPS 地址。
                  </p>
                  <ol className="agent-steps">
                    <li>
                      <strong>配置连接</strong>：在支持远程 MCP OAuth 的客户端中填写地址，选择
                      Streamable HTTP；在 WorthPath 网页登录后审核名称、回调和权限。
                    </li>
                    <li>
                      <strong>选择连接权限</strong>：先从 read
                      或草稿模式开始，根据需要增加权限。OAuth 访问令牌 1 小时，刷新授权最多 30
                      天并轮换。
                    </li>
                    <li>
                      <strong>检查工具已加载</strong>：客户端须能列出 WorthPath 工具并成功调用
                      connection_info。只有网址、网页预览或“明白”回复不能证明已连接。
                    </li>
                    <li>
                      <strong>把操作说明交给 Agent</strong>
                      ：复制下方教程，不包含任何密码或令牌，再描述具体任务。
                    </li>
                    <li>
                      <strong>确认并查看结果</strong>：草稿在网页确认，Agent
                      可查询完成状态。随时在“已授权连接”撤销。
                    </li>
                  </ol>
                </details>
                <div className="agent-copy-row">
                  <h4>可直接复制给 Agent 的教程</h4>
                  <button
                    className="primary"
                    type="button"
                    onClick={() => void copy(instructions(data.mcpUrl), 'Agent 使用教程已复制')}
                  >
                    复制 Agent 使用教程
                  </button>
                </div>
                <details className="agent-details">
                  <summary>预览 Agent 使用教程</summary>
                  <textarea
                    className="agent-tutorial"
                    aria-label="Agent 使用教程"
                    readOnly
                    value={instructions(data.mcpUrl)}
                    rows={8}
                  />
                </details>
                <details className="agent-details">
                  <summary>本机 Codex：使用 OAuth，无需填写个人令牌</summary>
                  <p>
                    在运行 WorthPath 的电脑上打开 PowerShell。未添加连接时先运行第一行；已有
                    worthpath 连接时直接运行登录命令，在 WorthPath 网页登录并选择权限。
                  </p>
                  <pre>{`codex mcp add worthpath --url ${data.mcpUrl}\ncodex mcp login worthpath --scopes read --oauth-client-registration dcr\ncodex mcp list`}</pre>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() =>
                      void copy(
                        `codex mcp login worthpath --scopes read --oauth-client-registration dcr`,
                        'OAuth 登录命令已复制',
                      )
                    }
                  >
                    复制 OAuth 登录命令
                  </button>
                  <p className="muted">
                    read 为只读；草稿使用 read,draft，直接普通写入使用
                    read,write。登录后重启客户端或新建会话，并检查 WorthPath 工具已加载。
                  </p>
                  <p className="muted">
                    已验证 Codex CLI 0.160.0 的 OAuth/DCR 登录及其凭据通过官方 SDK
                    的初始化、工具发现和 connection_info。尚未验证 Codex
                    桌面会话内调用；云端聊天无法直接使用本机 localhost。
                  </p>
                </details>
                <details className="agent-details">
                  <summary>支持 Bearer 头的客户端与已验证 SDK 配置</summary>
                  <p>
                    仅在客户端明确支持 Bearer
                    认证时创建个人令牌，按其文档配置环境变量或凭据存储；不要放入聊天、URL
                    或教程。请求头为 Authorization: Bearer
                    &lt;令牌&gt;。个人令牌只显示一次，不能作为通用 OAuth 的替代。
                  </p>
                  <pre>{`new StreamableHTTPClientTransport(new URL(${JSON.stringify(data.mcpUrl)}), {\n  requestInit: { headers: { Authorization: 'Bearer ' + process.env.MCP_ACCESS_TOKEN } }\n});`}</pre>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() =>
                      void copy(
                        `$env:MCP_SERVER_URL=${JSON.stringify(data.mcpUrl)}\npnpm --filter @worthpath/api mcp:probe`,
                        '诊断命令已复制',
                      )
                    }
                  >
                    复制诊断客户端命令
                  </button>
                  <p className="muted">
                    先安全设置 MCP_ACCESS_TOKEN。实际验证客户端：官方 TypeScript SDK 1.31.0（OAuth /
                    Bearer）；其他 Agent 尚未验证，不提供未经验证的产品配置格式。
                  </p>
                </details>
              </section>
            </>
          )}
          {agentView === 'tools' && (
            <>
              <section className="agent-card agent-wide">
                <h3>Agent 可以做什么</h3>
                <p className="muted">
                  这里列出服务实际提供的工具。能否执行还取决于连接权限、隐藏账户授权、项目归属和草稿确认。
                </p>
                <div className="agent-capabilities">
                  {capabilityGroups.map((g) => (
                    <details className="agent-details" key={g.title}>
                      <summary>{g.title}</summary>
                      <p>{g.summary}</p>
                      <ul>
                        {data.capabilities
                          .filter((t) => g.pattern.test(t.name))
                          .map((t) => (
                            <li key={t.name}>
                              <code>{t.name}</code> · {t.scope}
                              {t.destructive ? ' · 会删除数据' : ''}
                              <p>{t.description}</p>
                            </li>
                          ))}
                      </ul>
                    </details>
                  ))}
                </div>
                <details className="agent-details">
                  <summary>查看全部 {data.capabilities.length} 个工具（含连接与状态工具）</summary>
                  <ul>
                    {data.capabilities.map((t) => (
                      <li key={t.name}>
                        <code>{t.name}</code> · {t.scope}
                        <p>{t.description}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
              <section className="agent-card agent-wide">
                <details className="agent-details">
                  <summary>权限说明：read / draft / write</summary>
                  <p>选择一种连接权限：只读、草稿修改或直接写入。隐藏账户可单独授权读取和修改。</p>
                  <div className="agent-scope-grid">
                    {scopeDetails.map((s) => (
                      <article key={s.id}>
                        <h4>
                          {s.id} · {s.title}
                        </h4>
                        <strong>{s.summary}</strong>
                        <p>{s.detail}</p>
                      </article>
                    ))}
                  </div>
                </details>
              </section>
            </>
          )}
          {agentView === 'connections' && (
            <>
              <section className="agent-card">
                <details className="agent-details">
                  <summary>创建个人访问令牌（可选）</summary>
                  <p className="muted">
                    适用于支持 Bearer
                    头的客户端。固定期限到期后新建并撤销旧令牌；永久令牌不会自动过期，仍可撤销。
                  </p>
                  <form
                    className="agent-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget,
                        f = new FormData(form);
                      void act(async () => {
                        const v = await api<{ token: string }>('/agent/tokens', 'POST', {
                          name: f.get('name'),
                          days: f.get('days') === 'permanent' ? null : Number(f.get('days')),
                          password: f.get('password'),
                          scopes: [
                            'read',
                            ...(f.get('permission') !== 'read'
                              ? [String(f.get('permission'))]
                              : []),
                            ...(f.get('hiddenRead') ? ['hidden_read'] : []),
                            ...(f.get('hiddenWrite') ? ['hidden_write'] : []),
                          ],
                        });
                        setToken(v.token);
                        form.reset();
                        setTokenPermission('read');
                        setTokenHiddenRead(false);
                        setTokenHiddenWrite(false);
                      });
                    }}
                  >
                    <label>
                      连接名称
                      <input name="name" required maxLength={100} placeholder="例如：桌面助手" />
                    </label>
                    <label>
                      令牌有效期
                      <select name="days" defaultValue="30">
                        {durationOptions.map(([v, label]) => (
                          <option key={v} value={v}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      连接权限
                      <select
                        name="permission"
                        value={tokenPermission}
                        onChange={(e) => {
                          setTokenPermission(e.target.value);
                          if (e.target.value === 'read') setTokenHiddenWrite(false);
                        }}
                      >
                        <option value="read">只读</option>
                        <option value="draft">草稿修改（网页确认）</option>
                        <option value="write">直接写入</option>
                      </select>
                    </label>
                    <fieldset className="agent-scope-options">
                      <legend>隐藏账户权限（默认关闭）</legend>
                      <label>
                        <input
                          type="checkbox"
                          name="hiddenRead"
                          checked={tokenHiddenRead}
                          onChange={(e) => {
                            setTokenHiddenRead(e.target.checked);
                            if (!e.target.checked) setTokenHiddenWrite(false);
                          }}
                        />
                        允许读取隐藏账户
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          name="hiddenWrite"
                          disabled={!tokenHiddenRead || tokenPermission === 'read'}
                          checked={tokenHiddenWrite}
                          onChange={(e) => setTokenHiddenWrite(e.target.checked)}
                        />
                        允许修改隐藏账户（同时勾选读取，且选择草稿或直接写入）
                      </label>
                    </fieldset>
                    <label>
                      验证当前密码
                      <input
                        name="password"
                        type="password"
                        required
                        autoComplete="current-password"
                      />
                    </label>
                    <button className="secondary" disabled={busy}>
                      创建个人令牌
                    </button>
                  </form>
                  {token && (
                    <div role="status" className="agent-secret">
                      <p>完整令牌仅显示这一次，请妥善保存到客户端凭据设置。</p>
                      <code className="agent-address">{token}</code>
                      <div className="actions">
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => void copy(token, '令牌已复制')}
                        >
                          复制令牌
                        </button>
                        <button className="secondary" type="button" onClick={() => setToken('')}>
                          隐藏令牌
                        </button>
                      </div>
                    </div>
                  )}
                </details>
              </section>
              <section className="agent-card agent-wide">
                <div className="agent-copy-row">
                  <h3>已授权连接（最近 100 条）</h3>
                  <button
                    className="secondary"
                    disabled={busy}
                    type="button"
                    onClick={() => void act(load)}
                  >
                    刷新状态
                  </button>
                </div>
                {!data.grants.length && (
                  <p className="muted">尚未授权连接。通过 OAuth 接入，或创建个人令牌。</p>
                )}
                {data.grants.map((g) => (
                  <div key={g.id} className="agent-row">
                    <div>
                      <strong>{g.name}</strong>
                      <p>
                        {g.clientId ? 'OAuth' : '个人令牌'} · {g.scopes.join(', ')} ·{' '}
                        {g.revokedAt
                          ? '已撤销'
                          : g.expiresAt && new Date(g.expiresAt) <= new Date()
                            ? '已过期'
                            : '有效'}
                      </p>
                      <small>
                        {g.expiresAt
                          ? '到期：' + new Date(g.expiresAt).toLocaleString()
                          : '永久 · 不会自动过期'}
                      </small>
                    </div>
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
              </section>
            </>
          )}
          {agentView === 'operations' && (
            <>
              <section className="agent-card agent-wide">
                <h3>待确认及最近操作</h3>
                {!data.operations.length && (
                  <p className="muted">暂无操作。Agent 发起的草稿会出现在这里。</p>
                )}
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
                <details className="agent-details">
                  <summary>最近调用 · 不保存参数、密码或令牌</summary>
                  {!data.calls.length && <p className="muted">暂无调用记录。</p>}
                  {data.calls.map((c) => (
                    <div key={c.id} className="agent-row">
                      {c.tool} · {c.status} · {new Date(c.createdAt).toLocaleString()}
                    </div>
                  ))}
                </details>
              </section>
            </>
          )}
        </div>
      )}
      {consent && (
        <div className="agent-confirm">
          <h3>审核 OAuth 连接</h3>
          <p>{consent.name}</p>
          <p>权限：{consent.scopes.join(', ')}</p>
          <p>资源：{consent.resource}</p>
          <p>回调地址：{consent.redirectUri}</p>
          <p className="muted">只批准你正在连接的客户端；请核对回调地址。</p>
          <label>
            授予此连接的权限
            <select
              value={consentLevel}
              onChange={(e) => {
                setConsentLevel(e.target.value);
                if (e.target.value === 'read') setConsentHiddenWrite(false);
              }}
            >
              <option value="read">只读</option>
              {consent.scopes.includes('draft') && (
                <option value="draft">草稿修改（网页确认）</option>
              )}
              {consent.scopes.includes('write') && <option value="write">直接写入</option>}
            </select>
          </label>
          {consent.scopes.includes('hidden_read') && (
            <label>
              <input
                type="checkbox"
                checked={consentHiddenRead}
                onChange={(e) => {
                  setConsentHiddenRead(e.target.checked);
                  if (!e.target.checked) setConsentHiddenWrite(false);
                }}
              />
              允许读取隐藏账户
            </label>
          )}
          {consent.scopes.includes('hidden_write') && (
            <label>
              <input
                type="checkbox"
                disabled={!consentHiddenRead || consentLevel === 'read'}
                checked={consentHiddenWrite}
                onChange={(e) => setConsentHiddenWrite(e.target.checked)}
              />
              允许修改隐藏账户
            </label>
          )}
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
                    {
                      approve,
                      scopes: consent.scopes.filter(
                        (s) =>
                          s === 'read' ||
                          s === consentLevel ||
                          (s === 'hidden_read' && consentHiddenRead) ||
                          (s === 'hidden_write' && consentHiddenWrite),
                      ),
                    },
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
                const form = e.currentTarget;
                void act(async () => {
                  await api('/agent/operations/' + preview.operationId, 'POST', {
                    approve: true,
                  });
                  form.reset();
                  await show(preview.operationId);
                  setMessage('操作已提交，Agent 可以查询最终结果');
                });
              }}
            >
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
