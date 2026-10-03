# WorthPath 远程 MCP 接入

## 开始使用

网站「设置与备份 → 连接 Agent」显示实际 MCP 地址、写入策略、OAuth 连接、个人令牌、待确认操作和最近调用。默认写入策略为草稿。现有网页登录、REST 和数据计算规则保留。

1. 支持远程 OAuth 的客户端填写页面显示的 MCP 地址，选择 Streamable HTTP。
2. 客户端通过 `401 WWW-Authenticate` 或 `/.well-known/oauth-protected-resource/mcp` 发现授权服务。支持 OAuth 2.1 授权码、S256 PKCE、RFC 8707 resource、动态注册的公开客户端。
3. 浏览器进入 WorthPath，登录或注册，核对客户端名称、回调地址、资源和权限后授权。网站会回到注册的精确回调地址并保留 state。
4. 只请求需要的权限：`read` 查询；`draft` 创建草稿；`write` 普通写入；`sensitive` 发起敏感流程。所有授权包含 read。敏感权限仍要求网页验证当前密码，不能用工具参数确认。
5. 查询用稳定 UUID。写入先调用 `state_get`，把返回的 state 作为 `expectedState`，同时提供同用户唯一 `idempotencyKey`。状态变化后重新查询并使用新键；网络重试必须保持同键、同参数、同 expectedState。
6. 返回 pending 时打开 `confirmationUrl`，用户审核影响并提交或取消。Agent 使用 `operation_get(operationId)` 查询 completed、cancelled、expired 及最终结果。提交失败保留草稿并返回最近失败原因，用户可以重试或取消。

密码只在网站填写。账号或密码修改后其他连接撤销，当前发起连接只保留 5 分钟 read 权限以读取完成结果，不可刷新；需要重新授权才能继续写入。隐藏资产解锁仅持续 5 分钟并限定当前连接，网站的解锁不自动授予 Agent。

## 贵金属按克数接入

新增 `metal_holding_create`：name、currency、metalType(gold/silver)、metalGrams、metalPurity、autoValuation、date，买入价 metalCostPerGram 可省略或 null；无需填写金额或市场价格。写入仍需 expectedState 和 idempotencyKey，并遵循写入策略。有对应业务日或更早报价时复用估值逻辑创建历史，没有报价时返回 valuationAvailable=false，查询总额 complete=false 与 missingValuations。position_get/list 返回可选 metalCost 和 metalProfit，均为原币十进制字符串。成本按实物重量计算，市场价值按重量×纯度×每克纯金属报价计算。

metal_configure 省略 metalCostPerGram 保留旧成本，传 null 清除。克数或成本修改与其他写入一样参与并发状态校验；盈亏由共享业务服务计算，不存储额外浮点累计值。[更新与验证](update-metal-grams-2026-10-03.md)。

## 开发启动与环境

```powershell
cd E:\WorthPath
.\scripts\pnpm.ps1 install
# 保留已有 apps/api/.env，按 .env.example 增加下面三项配置。
.\scripts\pnpm.ps1 db:generate
.\scripts\pnpm.ps1 db:migrate
.\scripts\pnpm.ps1 dev
```

生成 Prisma 前暂停 API，Windows 会锁定其引擎 DLL。迁移仅 deploy，不 reset。

| 变量                | 本地示例                  | 用途                                                 |
| ------------------- | ------------------------- | ---------------------------------------------------- |
| MCP_PUBLIC_URL      | http://localhost:3100/mcp | 固定的 OAuth resource；生产必须 HTTPS，路径必须 /mcp |
| MCP_WEB_URL         | http://localhost:5173     | 网页授权和操作确认入口；生产必须 HTTPS               |
| MCP_ALLOWED_ORIGINS | http://localhost:5173     | 精确浏览器 Origin 列表，逗号分隔，不支持通配符       |

生产继续要求 COOKIE_SECURE=true、准确的 WEB_ORIGIN。MCP 请求以独立 Bearer 验证，不接受网页登录 Cookie 作为授权，不把会话 ID 当凭证。未带 Origin 的非浏览器客户端允许接入；带 Origin 的请求必须匹配列表。Host 必须匹配规范资源地址。反向代理应传递规范的 Host，不以任意转发头构造资源 URL。

## 已验证的客户端配置

实际验证：官方 `@modelcontextprotocol/sdk@1.31.0`，StreamableHTTPClientTransport；Bearer PAT 和 OAuth 动态注册/发现/PKCE/刷新/撤销均经真实本地服务测试。服务协商 SDK 1.31.0 支持的协议，默认最新 `2025-11-25`。选择维护中的 v1 API 并精确锁定版本，未混用 v2 示例。[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[对应授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

下面是测试使用的官方 SDK 构造形式：

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'WorthPath client', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://localhost:3100/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + process.env.MCP_ACCESS_TOKEN } },
  }),
);
console.log(await client.listTools());
await client.close();
```

本项目提供只读协议诊断客户端，完整个人令牌在网站创建时仅展示一次：

```powershell
$env:MCP_SERVER_URL='http://localhost:3100/mcp'
# 在本机终端设置 MCP_ACCESS_TOKEN；不要写进仓库或聊天。
pnpm --filter @worthpath/api mcp:probe
Remove-Item Env:MCP_ACCESS_TOKEN
```

OAuth 客户端使用 `authProvider` 代替手工 Bearer 头；实现 SDK 的 OAuthClientProvider，在 `redirectToAuthorization` 打开浏览器，在回调后调用 transport.finishAuth(code) 再连接。真实的 provider、发现和交换实现见 `apps/api/test/mcp.test.ts` 第三组测试。生产客户端还应独立校验 state，安全持久化 verifier、客户端注册和令牌，禁止跨用户共享。WorthPath 返回原 state，但客户端必须自行验证。

没有验证 MCP Inspector、Claude、ChatGPT、Cursor、Codex 或其他产品的实际 OAuth/config 格式，不提供猜测配置或普遍兼容承诺。HTTPS 代理环境也未实际部署验证。

## 写入、权限和一致性

| 用户策略      | draft 权限    | write 权限    | sensitive 权限                                     |
| ------------- | ------------- | ------------- | -------------------------------------------------- |
| readonly      | 拒绝写入/上传 | 拒绝写入/上传 | 仅允许网页确认的完整备份导出和隐藏解锁，不修改账目 |
| draft（默认） | 保存草稿      | 保存草稿      | 强制网页确认                                       |
| direct        | 保存草稿      | 执行普通写入  | 强制网页确认                                       |

草稿 10 分钟到期，保存用户、连接、具体参数、账目摘要和状态。提交重新检查连接过期/撤销、scope、当前策略、账目状态、数据归属及业务规则。`confirmed=true` 被严格 Schema 拒绝。修改隐藏密码要求的设置、发布共享图标也升级为敏感确认。

幂等记录和业务变更在同一 Serializable 数据库事务提交，用户唯一键保证重试不重复入账。同键不同参数或不同连接明确拒绝。所有普通直接写入和草稿提交通过状态摘要防止覆盖 REST 或其他 Agent 的并发修改。状态包括全部用户账目、历史、计划、汇率、金属报价及相关设置，只返回摘要，不返回隐藏数据。

复用现有 Decimal、余额计算、转账和历史重放。AsyncLocalStorage 仅保存当前数据库事务，认证信息来自每请求的 Bearer 上下文。现有服务中的嵌套事务加入 MCP 外层事务；MCP 计划执行任一失败会回滚整批，REST 仍保留逐计划执行和失败列表语义。

金额为十进制字符串，现有 DECIMAL(24,8) 和报价/汇率 DECIMAL(24,12) 保留。`balance_record.amount` 为绝对余额；转账本金/到账/手续费是增量。负债账户数据库正数为欠款，负数为溢缴存款；网站显示相反符号。独立资产和借贷本金非负。业务日期 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm` 为 UTC+8；返回时间戳为 UTC ISO。计划 nextAt 可在未来，余额记录日期不可在未来。

查询页 limit 最多 100；图标固定 60；历史和资金往来使用 cursor，列表使用 offset。净资产轨迹沿用范围上限：日 366 天、周 3 年、月 10 年。金属和汇率返回最近 100 条。大备份通过文件入口传输。

## 备份、图标和敏感操作

备份追加：`file_upload_request(kind=backup)` → 使用返回 URL 和当前 Bearer 以 multipart/form-data 的 file 字段上传 ZIP/旧 JSON → 获取 token 或 `file_status` → `import_preview` → `backup_import` → 网页核对影响并验证密码 → `operation_get`。文件上传上限 512 MiB，ZIP 解压上限沿用现有 1 GiB；实际预检与追加恢复沿用现有严格校验和事务，任何冲突不修改账目。

完整导出：`backup_export` → 网页密码确认 → `operation_get` 获得 10 分钟有效的 GET URL → 同一连接 Bearer 下载 ZIP。URL 单独不可下载，其他用户/连接不可下载，账目变化必须重新确认。备份包含隐藏项目，但不含密码、Cookie 或 MCP 令牌。Agent 授权、草稿和调用日志不属于财务备份。

图标：`file_upload_request(kind=icon)` 上传不超过 2 MiB 的图像 → `icon_publish` 保存私有图标；shared=true 需敏感权限、中文名称、网页明确确认 → `icon_image` 获取受 Bearer 保护的 PNG URL。

清空数据：`data_clear_request` → 网页展示项目/历史/计划数量 → 先在网页下载最新备份 → 验证当前密码并输入“确定清空” → 提交 → `operation_get`。已有备份指纹与 10 分钟有效期规则保留，任何账目变化都要求重新备份。登录账号和共享图标保留。

当前产品不存在账户注销、任意单个持仓删除、覆盖导入、批量删除和另外的分类实体；因此不新增此类业务。已有删除路径是历史、资金往来、计划删除及备份保护的全量清空，完整支持。名称、分组、分类、图标、归档和统计开关通过 position_update/settings_update 设置。完整覆盖和逐项证据见 [覆盖矩阵](mcp-coverage.md)。

## 服务和代理

采用无状态 Streamable HTTP：每个 POST 新建 server/transport，独立 Bearer 认证；关闭响应时释放 transport。响应为 SDK 标准 JSON MCP 结果，支持初始化、协商、工具发现和调用。GET/DELETE 返回 405，没有长期 SSE 会话或会话凭证。当前没有订阅通知需求。

现有备份上传及 MCP 文件票据在进程内，10–15 分钟过期；进程重启或切换节点后需重新上传/生成入口。**当前部署必须单 API 实例**，不能直接在多节点间轮询文件请求；OAuth、令牌、草稿、幂等和审计本身已持久化。日志不保存工具参数、密码、令牌或财务内容，管理页只展示用户自己的最近 100 条。

反向代理参考（示例未经实际部署，修改为自己的 HTTPS 域名及上游）：

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 330s;
    proxy_send_timeout 330s;
}
location /api/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    client_max_body_size 512m;
    proxy_read_timeout 330s;
}
# 同样代理 /.well-known/、/authorize、/token、/register、/revoke。
# 前端静态站点与 MCP_WEB_URL 应位于已配置的 HTTPS origin。
```

用户认证数据不进入全局共享变量。SDK OAuth 路由包含进程内限流，现有登录限流也保留，已认证动作按用户及来源 IP 限流。生产单实例应另外配置代理级流量限制和日志保留策略；不得在代理访问日志中记录 Authorization、上传正文或敏感查询参数。数据库账号需要现有 DDL 迁移权限及正常业务 DML 权限。

## 实际验证与交付

迁移：`20261003090000_agent_access` 新增授权/令牌/策略/操作 5 表；`20261003100000_agent_audit` 新增无参数调用审计；`20261003110000_agent_comments` 补齐 6 张新表字段的 MySQL 注释。原有财务表与记录保留。已经 migrate deploy，未执行 reset。

主要修改：原 8 个业务模块及 auth 抽取 BusinessService；database 增加事务上下文；新增 `src/mcp/{oauth,catalogue,operations,files,management,transport}.ts`；设置页新增 AgentConnections；SDK 精确版本和 pnpm lock；新增真实 MCP 测试及只读 probe。

实际通过：前后端 typecheck/build、36 项单元检查、18 组真实 REST/MySQL 回归、3 组真实官方 MCP SDK 端到端检查，工具发现验证 49 个工具（原 mcp:probe 的 48 个工具上增加 metal_holding_create）。新迁移 deploy 成功，实际 MySQL 17 张表（含 Prisma 迁移表）、159 个字段注释完整。测试真实连接 MySQL，使用随机临时用户并清理，未替代现有 REST 回归。端到端文件传输、事务回滚、归属、金额精度、幂等、并发、失效/撤销和 OAuth 均在测试中检查；外部行情源的正常和失败路径由原业务单元测试验证，不保证外部报价服务实时可用。

部署未执行；未推送代码；其他客户端及实际 HTTPS/代理兼容性尚未验证。
