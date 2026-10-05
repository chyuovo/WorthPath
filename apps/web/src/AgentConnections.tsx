import { useEffect, useState } from 'react';
import { api } from './api';
import { AgentDrafts, ReviewDialog } from './AgentDrafts';
import { toolLabel, statusLabel, permissionLabel } from './agent-display';
import { showToast, useToast } from './Toast';

type Connection = {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  refreshExpiresAt: string | null;
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
function instructions(url: string) {
  return [
    '以下是配置 MCP 连接后的操作说明，不会自动添加连接或授予工具。若本会话没有 WorthPath 工具，请先告知我，并指导我在客户端配置连接；不要仅凭网址或聊天中的令牌声称已连接。',
    '请使用已连接的 WorthPath MCP 服务处理我的资产与负债，服务地址：' + url,
    '接入使用 Streamable HTTP。支持 OAuth 的客户端使用该地址发现授权服务，并由我在 WorthPath 网页登录授权；个人令牌仅用于明确支持 Bearer 认证的客户端，按其文档配置环境变量或凭据存储。不要假设客户端有自定义请求头界面，不要让我把密码或令牌粘贴到对话中。localhost 仅适用于 MCP 请求在 WorthPath 所在电脑执行的客户端；云端客户端需要可访问的 HTTPS 地址。',
    '连接时先 tools/list 发现真实工具，再调用一次 connection_info 核对当前 resource、permission、scopes 和隐藏账户读写权限，并在本次连接中缓存结果。权限可能被我在网页修改，以服务器返回的当前权限为准，不把以前申请或聊天中的权限当作永久授权。read 只读，draft 创建待网页确认的草稿，write 直接普通写入。无需每次查询或写入前重复检查；仅在重新连接或授权、我告知权限已变更、遇到权限/授权错误，或当前缓存不足以判断能否执行任务时，再检查一次并更新缓存。不得自动扩大权限或绕过确认；不匹配预期时报告实际差异。',
    '查询：用 positions_list 搜索对象；需要选定对象且遇到同名时先让我选择稳定 UUID；按 limit/offset 或 cursor 完整翻页。金额和克数使用十进制字符串，业务时间是 UTC+8 的 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。不同币种不能直接相加；明确折算币种、汇率日期、统计纳入范围及缺失汇率或估值。不擅自排除测试项目或其他项目；若提供剔除后的参考汇总，同时说明系统实际汇总与剔除项，不修改纳入设置。',
    '写入：先 state_get 取得 state，使用 expectedState 与唯一 idempotencyKey 调用所需工具。网络重试保持键和全部参数一致；状态冲突则重新查询并换键。不要把估值更新、转账、还款或负债变化互相替代。',
    '若返回 pending，把 confirmationUrl 给我，由我在网页审阅并确认；用 operation_get 轮询最终结果，不能用 confirmed=true 代替人类确认，也不能把草稿称为已完成。',
    'MCP 不提供密码修改、清空数据、备份导出恢复、共享图标发布及汇率或报价修改；这些流程由我在网站操作。',
    '我接下来会告诉你具体任务；在我提出任务前先不要修改数据。未发现的工具或未授予的权限请如实告知，不要猜测成功。',
  ].join('\n\n');
}

function codexSetupPrompt(url: string, level: string, hiddenRead = false, hiddenWrite = false) {
  const requestedHiddenWrite = hiddenRead && hiddenWrite && level !== 'read';
  const selected = [
    'read',
    ...(level !== 'read' ? [level] : []),
    ...(hiddenRead ? ['hidden_read'] : []),
    ...(requestedHiddenWrite ? ['hidden_write'] : []),
  ].join(',');
  return [
    '请直接在这台电脑上配置并验证 WorthPath MCP，让其他本机 Codex 新对话也能使用，并在我提出余额、账户、资产、负债、净资产、历史、转账、借贷、还款等相关任务时主动优先调用它。不要只给我命令或方案。我授权必要的本机检查、新增或更新名为 worthpath 的 Streamable HTTP 与 OAuth 连接、发起 OAuth，以及保存下面的跨对话使用规则。仅修改 worthpath 连接及全局指令文件中的 WorthPath 规则，保留其他 MCP、Codex 配置和已有指令。配置和验证期间不得创建、修改或删除账目。',
    '服务地址：' +
      url +
      '。申请权限：' +
      selected +
      '。隐藏账户读取：' +
      (hiddenRead ? '允许' : '不允许') +
      '；隐藏账户修改：' +
      (requestedHiddenWrite ? '允许' : '不允许') +
      '。最终权限和授权期限由我在 WorthPath 网页审核完成。不要让我把密码或个人令牌发送到聊天里，也不要替我点击授权确认。',
    '先确认执行环境确实在这台电脑上，再检查 codex 命令、实际版本及 codex mcp add --help、codex mcp login --help。只检查 WorthPath 相关连接配置，输出经过筛选的名称、地址、启用状态和认证类型，不输出凭据、Authorization 头、令牌或其他连接详情。如果运行在云端或另一台电脑，无法访问上述服务地址，请如实说明，不要声称已连接。',
    'Windows 命令执行排查也请由你完成，不要一遇到 PowerShell 挂起就让我自行确认 CLI。版本和帮助检查是短命令：执行工具支持时先设置 login:false（或等效 -NoProfile），避免启动配置文件。若短命令超过 15 秒无输出，结束你自己启动的这一条检查，不要停止 WorthPath 服务或其他进程；不要反复原样重试。',
    '若普通沙箱检查挂起或权限不足，使用执行工具提供的正常权限申请流程，申请 sandbox_permissions=require_escalated 或等效本机执行权限，说明用途是核对 Codex CLI、配置 WorthPath OAuth及保存跨对话使用规则。我授权这些必要操作。获得工具批准后继续执行；若被拒绝，报告具体拒绝原因和受影响步骤。不要绕过权限限制，也不要仅因普通沙箱命令挂起就认定 CLI 不可用。',
    'CLI 找不到时，在本机已安装 Codex 的官方目录中定位可执行文件并使用完整路径；不要安装未知程序、永久修改 PATH 或读取其他凭据。区分短命令故障和 OAuth 等待：授权登录进程在等待网页回调时应保留，不适用上述 15 秒短命令期限。',
    '使用 codex mcp add worthpath --url ' +
      url +
      ' 添加连接；已有同名、同地址且启用的 OAuth 连接时跳过添加。同地址连接被禁用时仅启用它；同名连接指向不同服务时说明冲突，等待我决定，不覆盖。若这条连接使用旧 Bearer 认证，将本连接切换为 OAuth，移除 bearer_token_env_var 和静态或环境映射的 Authorization 头，保留其余配置，不展示旧令牌。',
    'mcp add 可能自动发起默认 OAuth。避免产生两条同时等待的授权流程；如需切换到下方显式登录，可以结束自己启动的自动登录等待，再启动指定 scopes 的登录。不要把默认候选权限较宽当作登录故障。',
    '执行 codex mcp login worthpath --scopes ' +
      selected +
      ' --oauth-client-registration dcr 发起网页登录。我会自行登录并确认权限。等待回调时保留登录进程；需要等待我完成网页步骤时，明确告诉我当前状态。',
    '若授权链接包含 read,draft,write,hidden_read,hidden_write 等较宽范围，这是客户端候选范围，不代表最终授权。WorthPath 网页支持收窄，服务端按网页选择发行令牌。打开正确 WorthPath 资源的授权页供我审阅；由我选择本次指定的权限等级、隐藏账户读写选项和授权期限并确认。不要仅因候选范围较宽就终止登录；最终以 connection_info 返回的实际权限为准。',
    '分别验证连接配置正确且启用、OAuth 登录成功、真实 MCP 工具调用成功，三者不能互相替代。首次连接通过 tools/list 或客户端暴露的工具目录发现真实工具，再调用一次 connection_info 核对并缓存当前授权。resource 必须为 ' +
      url +
      '，permission 必须为 ' +
      level +
      '，最终 scopes 集合必须恰好为 ' +
      selected +
      '（顺序不限），且 readHidden=' +
      hiddenRead +
      '、writeHidden=' +
      requestedHiddenWrite +
      '。若结果不符，停止使用该连接并报告差异，不修改账目。若当前会话不会重新加载工具，请告诉我重启客户端或新建本机会话后继续验证。只有配置、OAuth 成功和工具调用成功都验证后才能说已可用，不把 codex mcp list 或网页登录成功当作工具调用成功。此处申请范围用于首次配置验收；之后权限可能由我在网页更改，按当前服务器授权判断可执行范围。无需每次操作前重复检查，仅在重新连接/授权、我告知变更、权限错误或缓存不足时再检查一次。',
    '保存跨对话使用规则：在实际 CODEX_HOME（默认 ~/.codex）的全局指令中，先检查 AGENTS.override.md 与 AGENTS.md 的加载优先级，在会被加载的文件中新增或更新 <!-- worthpath-mcp-preference:start --> 与 <!-- worthpath-mcp-preference:end --> 标记块。保留已有内容，只更新此块；不要创建会遮蔽其他全局指令的 override 文件，不重复添加规则。',
    '全局规则应保存本次服务地址、申请的权限等级、scopes 和隐藏账户读写选项，以及下面的查询和写入操作规则。每个新会话连接时先发现真实工具，再调用一次 connection_info 核对并缓存当前资源、权限、scopes 与隐藏读写；与本次明确预期不符时停止使用并报告差异。权限可能在网页被更改，旧申请和旧聊天不代表当前授权。无需每次操作前重复检查；只在重新连接/授权、用户告知权限变更、权限错误或缓存不足时再检查一次并更新缓存。用户提出个人余额、账户、资产、负债、净资产、历史、转账、借贷、还款或其他 WorthPath 任务时主动优先调用 worthpath MCP，不要求重复指定，不把旧聊天余额当作当前数据。这项偏好仅决定工具选择；只有用户提出具体写入任务后才执行，不自动授权账目修改。',
    '工具未加载、服务不可达或授权失效时如实说明，必要时提示重新授权、重启客户端或新建本机会话，不擅自改用 UI/API 写入。不记录密码、令牌、账户余额或其他财务明细到全局指令中。保存后验证文件内容与加载条件，说明规则适用于这台电脑使用同一 Codex 配置的本机会话，不声称自动适用于其他电脑或云端会话。',
    ...instructions(url).split('\n\n').slice(3),
    '完成后简要报告连接配置、OAuth、真实工具验证和全局规则保存的实际结果及剩余步骤。在我提出具体账目任务前，不修改任何数据。',
  ].join('\n\n');
}

const connectionExpiry = (g: Connection) => (g.clientId ? g.refreshExpiresAt : g.expiresAt);
export function AgentConnections({ changed }: { changed?: () => void }) {
  const [editing, setEditing] = useState<Connection | null>(null);
  const [editPermission, setEditPermission] = useState('read');
  const [editHiddenRead, setEditHiddenRead] = useState(false);
  const [editHiddenWrite, setEditHiddenWrite] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [data, setData] = useState<Management | null>(null),
    [view, setView] = useState('connect'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [permission, setPermission] = useState('draft'),
    [codexHiddenRead, setCodexHiddenRead] = useState(false),
    [codexHiddenWrite, setCodexHiddenWrite] = useState(false),
    [token, setToken] = useState(''),
    [tokenPermission, setTokenPermission] = useState('read'),
    [hiddenRead, setHiddenRead] = useState(false),
    [hiddenWrite, setHiddenWrite] = useState(false),
    [search, setSearch] = useState('');
  useToast(error, 'error');
  const load = async () => setData(await api<Management>('/agent'));
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void act(load);
  }, []);
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label, 'success');
    } catch {
      showToast('复制失败，请展开文本后手动复制', 'error');
    }
  }
  const pending =
    data?.operations.filter((o) => o.status === 'pending' && new Date(o.expiresAt) > new Date()) ||
    [];
  const active =
    data?.grants.filter(
      (g) => !g.revokedAt && (!connectionExpiry(g) || new Date(connectionExpiry(g)!) > new Date()),
    ) || [];
  return (
    <section className="panel agent-panel">
      <div className="agent-heading">
        <div>
          <p className="eyebrow">AGENT CONNECTIONS</p>
          <h2>让助手连接你的资产空间</h2>
          <p className="muted">选择权限、连接助手，随时查看和管理它提出的修改。</p>
        </div>
        <button className="secondary" disabled={busy} onClick={() => void act(load)}>
          刷新
        </button>
      </div>
      <nav className="agent-tabs" aria-label="Agent 功能分区">
        {[
          ['connect', '连接助手'],
          ['connections', '我的连接'],
          ['operations', '草稿与记录'],
          ['tools', '能力与权限'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={view === key ? 'primary' : 'secondary'}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
            {key === 'connections'
              ? ' · ' + active.length
              : key === 'operations' && pending.length
                ? ' · ' + pending.length
                : ''}
          </button>
        ))}
      </nav>
      {!data && <p>{error ? '连接信息加载失败，请点击刷新重试。' : '正在读取连接信息…'}</p>}
      {data && view === 'connect' && (
        <div className="agent-connect-layout">
          <section className="agent-card agent-setup">
            <span className="agent-step-number">1</span>
            <h3>选择助手能做什么</h3>
            <div className="agent-permission-choices">
              {[
                ['read', '只读查询', '只查看账户、余额和统计。'],
                ['draft', '草稿修改', '每次修改先由你确认，建议从这里开始。'],
                ['write', '直接写入', '普通修改立即执行，适合你信任的助手。'],
              ].map(([key, title, detail]) => (
                <button
                  key={key}
                  className={
                    permission === key ? 'permission-choice selected' : 'permission-choice'
                  }
                  aria-pressed={permission === key}
                  onClick={() => {
                    setPermission(key);
                    if (key === 'read') setCodexHiddenWrite(false);
                  }}
                >
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </button>
              ))}
            </div>
            <fieldset className="agent-scope-options">
              <legend>申请隐藏账户权限（默认关闭）</legend>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={codexHiddenRead}
                  onChange={(e) => {
                    setCodexHiddenRead(e.target.checked);
                    if (!e.target.checked) setCodexHiddenWrite(false);
                  }}
                />
                允许读取隐藏账户
              </label>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={codexHiddenWrite}
                  disabled={!codexHiddenRead || permission === 'read'}
                  onChange={(e) => setCodexHiddenWrite(e.target.checked)}
                />
                允许修改隐藏账户
              </label>
            </fieldset>
            <span className="agent-step-number">2</span>
            <h3>把配置提示词发送给 Codex</h3>
            <p>本机 Codex 会配置连接并打开独立授权页。你只需登录并核对权限。</p>
            <button
              className="primary"
              onClick={() =>
                void copy(
                  codexSetupPrompt(data.mcpUrl, permission, codexHiddenRead, codexHiddenWrite),
                  'Codex 配置提示词已复制',
                )
              }
            >
              复制 Codex 配置提示词
            </button>
            <details className="agent-details">
              <summary>预览配置提示词</summary>
              <textarea
                className="agent-tutorial"
                readOnly
                rows={6}
                aria-label="Codex 配置提示词"
                value={codexSetupPrompt(data.mcpUrl, permission, codexHiddenRead, codexHiddenWrite)}
              />
            </details>
            <span className="agent-step-number">3</span>
            <h3>确认连接后，开始交代任务</h3>
            <p>先让助手核对连接权限。草稿会出现在“草稿与记录”，确认后才会写入。</p>
            <button
              className="secondary"
              onClick={() => void copy(instructions(data.mcpUrl), 'Agent 使用教程已复制')}
            >
              复制后续操作说明
            </button>
            <details className="agent-details">
              <summary>预览操作说明</summary>
              <textarea
                className="agent-tutorial"
                readOnly
                rows={6}
                aria-label="Agent 使用教程"
                value={instructions(data.mcpUrl)}
              />
            </details>
          </section>
          <aside className="agent-card agent-help">
            <h3>其他客户端</h3>
            <p className="muted">使用支持 Streamable HTTP 和 OAuth 的 MCP 客户端。</p>
            <div className="agent-copy-row">
              <code className="agent-address">{data.mcpUrl}</code>
              <button
                className="secondary"
                onClick={() => void copy(data.mcpUrl, 'MCP 地址已复制')}
              >
                复制地址
              </button>
            </div>
            <p>localhost 适用于本机助手；云端助手需要能访问的 HTTPS 服务地址。</p>
            <details className="agent-details">
              <summary>接入与有效期</summary>
              <p>
                OAuth 访问令牌 1 小时；授权期限可选 1、3、7、30 天、1
                年或永久，刷新不会延长有限授权期限。配置连接后，客户端需要成功列出工具并调用
                connection_info。
              </p>
              <p>需要 Bearer 令牌的客户端，可在“我的连接”中创建个人令牌。</p>
            </details>
          </aside>
        </div>
      )}
      {data && view === 'connections' && (
        <>
          <section className="agent-card">
            <h3>已授权连接</h3>
            <p className="muted">
              最近 100 条 · 可修改权限，OAuth 也支持直接写入；撤销后助手无法继续访问。
            </p>
            {!data.grants.length && (
              <div className="agent-empty">
                <h4>还没有连接</h4>
                <p>先复制配置提示词，让助手发起连接。</p>
                <button className="primary" onClick={() => setView('connect')}>
                  连接助手
                </button>
              </div>
            )}
            {data.grants.map((g) => (
              <div className="agent-row" key={g.id}>
                <div>
                  <strong>{g.name}</strong>
                  <p>
                    {permissionLabel(g.scopes)} · {g.clientId ? 'OAuth' : '个人令牌'} ·{' '}
                    {g.revokedAt
                      ? '已撤销'
                      : connectionExpiry(g) && new Date(connectionExpiry(g)!) <= new Date()
                        ? '已过期'
                        : '有效'}
                  </p>
                  <small>
                    {g.scopes.includes('hidden_read')
                      ? g.scopes.includes('hidden_write')
                        ? '可读取和修改隐藏账户'
                        : '可读取隐藏账户'
                      : '不可访问隐藏账户'}{' '}
                    ·{' '}
                    {connectionExpiry(g)
                      ? '授权到期 ' + new Date(connectionExpiry(g)!).toLocaleString()
                      : '永久有效'}
                  </small>
                </div>
                {!g.revokedAt && (
                  <div className="actions">
                    {active.some((a) => a.id === g.id) && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setEditing(g);
                          setEditPermission(
                            g.scopes.includes('write')
                              ? 'write'
                              : g.scopes.includes('draft')
                                ? 'draft'
                                : 'read',
                          );
                          setEditHiddenRead(g.scopes.includes('hidden_read'));
                          setEditHiddenWrite(g.scopes.includes('hidden_write'));
                        }}
                      >
                        修改权限
                      </button>
                    )}
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api('/agent/connections/' + g.id, 'DELETE');
                          showToast('连接已撤销', 'success');
                        })
                      }
                    >
                      撤销连接
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
          <details className="agent-card agent-details">
            <summary>高级接入：创建个人令牌</summary>
            <p className="muted">仅供支持 Bearer 认证的客户端使用。完整令牌只显示一次。</p>
            <form
              className="agent-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget,
                  f = new FormData(form);
                void act(async () => {
                  const v = await api<{ token: string }>('/agent/tokens', 'POST', {
                    name: f.get('name'),
                    password: f.get('password'),
                    days: f.get('days') === 'permanent' ? null : Number(f.get('days')),
                    scopes: [
                      'read',
                      ...(tokenPermission !== 'read' ? [tokenPermission] : []),
                      ...(hiddenRead ? ['hidden_read'] : []),
                      ...(hiddenWrite ? ['hidden_write'] : []),
                    ],
                  });
                  setToken(v.token);
                  form.reset();
                  setTokenPermission('read');
                  setHiddenRead(false);
                  setHiddenWrite(false);
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
                  value={tokenPermission}
                  onChange={(e) => {
                    setTokenPermission(e.target.value);
                    if (e.target.value === 'read') setHiddenWrite(false);
                  }}
                >
                  <option value="read">只读查询</option>
                  <option value="draft">草稿修改</option>
                  <option value="write">直接写入</option>
                </select>
              </label>
              <fieldset className="agent-scope-options">
                <legend>隐藏账户权限（默认关闭）</legend>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={hiddenRead}
                    onChange={(e) => {
                      setHiddenRead(e.target.checked);
                      if (!e.target.checked) setHiddenWrite(false);
                    }}
                  />
                  允许读取隐藏账户
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={hiddenWrite}
                    disabled={!hiddenRead || tokenPermission === 'read'}
                    onChange={(e) => setHiddenWrite(e.target.checked)}
                  />
                  允许修改隐藏账户
                </label>
              </fieldset>
              <label>
                验证当前密码
                <input name="password" type="password" required autoComplete="current-password" />
              </label>
              <button className="primary" disabled={busy}>
                创建个人令牌
              </button>
            </form>
            {token && (
              <div className="agent-secret" role="status">
                <p>请将令牌保存到客户端凭据设置。</p>
                <code className="agent-address">{token}</code>
                <div className="actions">
                  <button className="secondary" onClick={() => void copy(token, '令牌已复制')}>
                    复制令牌
                  </button>
                  <button className="secondary" onClick={() => setToken('')}>
                    隐藏令牌
                  </button>
                </div>
              </div>
            )}
          </details>
        </>
      )}
      {data && view === 'operations' && (
        <section className="agent-card">
          <h3>待确认草稿</h3>
          <button className="primary" disabled={busy} onClick={() => setReview('all')}>
            审阅全部草稿
          </button>
          {!pending.length && <p className="agent-empty">没有等待确认的修改。</p>}
          {pending.map((o) => (
            <div className="agent-row" key={o.id}>
              <div>
                <strong>{toolLabel(o.tool)}</strong>
                <p className="muted">有效至 {new Date(o.expiresAt).toLocaleTimeString()}</p>
              </div>
              <button className="agent-review-link" onClick={() => setReview(o.id)}>
                审阅草稿
              </button>
            </div>
          ))}
          <details className="agent-details">
            <summary>最近操作（{data.operations.length}）</summary>
            {!data.operations.length && <p>暂无操作记录</p>}
            {data.operations.map((o) => (
              <div className="agent-row" key={o.id}>
                <div>
                  <strong>{toolLabel(o.tool)}</strong>
                  <p>
                    {statusLabel(
                      o.status === 'pending' && new Date(o.expiresAt) < new Date()
                        ? 'expired'
                        : o.status,
                    )}{' '}
                    · {new Date(o.createdAt).toLocaleString()}
                  </p>
                </div>
                <button className="text" onClick={() => setReview(o.id)}>
                  查看详情
                </button>
              </div>
            ))}
          </details>
          <details className="agent-details">
            <summary>调用日志</summary>
            <p className="muted">仅保存工具名称和状态，不保存参数、密码或令牌。</p>
            {!data.calls.length && <p>暂无调用记录</p>}
            {data.calls.map((c) => (
              <div className="agent-row" key={c.id}>
                <span>
                  {toolLabel(c.tool)} <small>({c.tool})</small> · {statusLabel(c.status)}
                </span>
                <small>{new Date(c.createdAt).toLocaleString()}</small>
              </div>
            ))}
          </details>
        </section>
      )}
      {data && view === 'tools' && (
        <>
          <div className="agent-scope-grid">
            {scopeDetails.map((s) => (
              <article className="agent-card" key={s.id}>
                <h3>{s.title}</h3>
                <p>{s.summary}</p>
                <details className="agent-details">
                  <summary>详细范围</summary>
                  <p>{s.detail}</p>
                </details>
              </article>
            ))}
          </div>
          <section className="agent-card">
            <h3>助手的能力</h3>
            <p className="muted">
              查询与修改受连接权限约束；账户密码、清空数据、备份恢复等仍由你在网站操作。
            </p>
            <label>
              搜索能力
              <input
                type="search"
                placeholder="例如：转账、余额、计划"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <div className="agent-tool-grid">
              {data.capabilities
                .filter((t) =>
                  (toolLabel(t.name) + ' ' + t.name + ' ' + t.description)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((t) => (
                  <article className="agent-tool-card" key={t.name}>
                    <h4>{toolLabel(t.name)}</h4>
                    <span className="badge">
                      {t.scope === 'read' ? '查询' : '草稿 / 写入'}
                      {t.destructive ? ' · 删除操作' : ''}
                    </span>
                    <details className="agent-details">
                      <summary>查看说明</summary>
                      <p>{t.description}</p>
                      <code>{t.name}</code>
                    </details>
                  </article>
                ))}
            </div>
            {!data.capabilities.some((t) =>
              (toolLabel(t.name) + ' ' + t.name + ' ' + t.description)
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p>没有匹配的能力。</p>}
          </section>
        </>
      )}
      {editing && (
        <ReviewDialog title="修改连接权限" close={() => setEditing(null)} busy={busy}>
          <p>
            <strong>{editing.name}</strong> · {editing.clientId ? 'OAuth' : '个人令牌'}
          </p>
          <p className="muted">
            保存后权限立即生效，授权期限保持不变。修改权限会取消该连接未确认的草稿，需要重新创建。
          </p>
          <form
            className="agent-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                await api('/agent/connections/' + editing.id, 'PATCH', {
                  password: f.get('password'),
                  scopes: [
                    'read',
                    ...(editPermission === 'read' ? [] : [editPermission]),
                    ...(editHiddenRead ? ['hidden_read'] : []),
                    ...(editHiddenRead && editHiddenWrite && editPermission !== 'read'
                      ? ['hidden_write']
                      : []),
                  ],
                });
                setEditing(null);
                showToast('连接权限已更新', 'success');
              });
            }}
          >
            <label>
              连接权限
              <select
                value={editPermission}
                onChange={(e) => {
                  setEditPermission(e.target.value);
                  if (e.target.value === 'read') setEditHiddenWrite(false);
                }}
              >
                <option value="read">只读查询</option>
                <option value="draft">草稿修改</option>
                <option value="write">直接写入</option>
              </select>
            </label>
            {editPermission === 'write' && (
              <p className="danger-text">
                直接写入会立即执行普通修改，无需逐次网页确认。请仅授予你信任的助手。
              </p>
            )}
            <fieldset className="agent-scope-options">
              <legend>隐藏账户权限</legend>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={editHiddenRead}
                  onChange={(e) => {
                    setEditHiddenRead(e.target.checked);
                    if (!e.target.checked) setEditHiddenWrite(false);
                  }}
                />
                允许读取隐藏账户
              </label>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={editHiddenWrite}
                  disabled={!editHiddenRead || editPermission === 'read'}
                  onChange={(e) => setEditHiddenWrite(e.target.checked)}
                />
                允许修改隐藏账户
              </label>
            </fieldset>
            <label>
              验证当前密码
              <input
                name="password"
                type="password"
                required
                maxLength={72}
                autoComplete="current-password"
              />
            </label>
            <div className="actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存权限
              </button>
            </div>
          </form>
        </ReviewDialog>
      )}
      {review !== null && (
        <AgentDrafts
          initialId={review === 'all' ? undefined : review}
          close={() => setReview(null)}
          changed={() => {
            void load();
            changed?.();
          }}
        />
      )}
    </section>
  );
}
