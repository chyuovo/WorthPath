# WorthPath 远程 MCP 接入

2026-10-04：服务提供 39 个工具。按用户最新要求，MCP 不再提供敏感操作、汇率或贵金属报价修改。网站保留备份、清空、密码修改和自动行情功能。完整覆盖矩阵见 [功能覆盖](mcp-coverage.md)，本次迁移及验证见 [更新记录](update-agent-backup-2026-10-04.md)。

## 开始连接

在「设置与备份 → 连接 Agent」复制实际 MCP 地址和“Agent 使用教程”。支持远程 OAuth 的客户端填写此地址，选择 Streamable HTTP；在 WorthPath 网页登录，审核客户端名称、回调地址、资源，并选择连接权限。网页会回到已注册的精确回调地址并保留 state。客户端自行验证 state。

OAuth 使用发现元数据、动态注册的公开客户端、授权码、S256 PKCE、RFC 8707 resource。每次 MCP 请求独立验证 Bearer；网页登录 Cookie、MCP 会话 ID 均不作为认证凭证。发现入口为 `/.well-known/oauth-protected-resource/mcp`，未授权响应提供 `WWW-Authenticate`。

| 连接权限 | OAuth/PAT scopes | 普通修改行为                     |
| -------- | ---------------- | -------------------------------- |
| 只读     | read             | 查询，拒绝修改和上传             |
| 草稿修改 | read draft       | 保存十分钟草稿，由用户在网页确认 |
| 直接写入 | read write       | 普通修改在事务中直接完成         |

选择一种权限等级，draft 和 write 不能同时授予。没有网站全局写入策略。hidden_read 额外允许读取隐藏账户；hidden_write 额外允许修改，必须同时拥有 hidden_read 和 draft/write。两个附加权限默认关闭，OAuth 网页也可选择关闭。服务在查询和修改时分别构造业务上下文，网页解锁状态不自动授予 Agent。

敏感操作（密码/账号修改、清空、备份导出恢复、公开图标发布、安全设置变更）仅在网站进行，不存在 sensitive scope。汇率和参考报价可以查询，MCP 不能修改或主动刷新。贵金属仍可按克数创建、设置成本和重量，并用已有报价更新资产估值；估值历史与报价是不同业务。

个人访问令牌仅作为支持自定义 Bearer 头客户端的补充。在网站验证当前密码，选择权限和 1、3、7、30 天、365 天或永久。完整值仅创建时展示，数据库只存 SHA-256 摘要。永久令牌数据库到期日为空，每个请求仍重新检查撤销和资源；为兼容 SDK 中间件，每次认证上下文有有限期验证断言，不改变令牌期限。永久令牌内部业务会话按天续期。OAuth 访问令牌一小时、刷新授权三十天，刷新时轮换摘要；不支持永久 OAuth。

旧连接有 write 时，现在直接执行普通修改；旧全局策略不再阻止它。只想创建草稿时，撤销旧连接并重新授权 read draft。历史策略行保留但不参与任何权限判断；旧敏感工具草稿不可提交。

## Agent 操作

查询使用稳定 UUID；名称重名时先让用户选择。列表 limit 最大 100；图标固定 60；历史和资金往来使用 cursor。日期为 UTC+8 业务日期 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`，返回时间戳使用 UTC ISO。金额、克数、汇率与报价为十进制字符串，沿用 Decimal 和 DECIMAL 规则。

写入先 `state_get`，再传 expectedState、唯一 idempotencyKey 与具体工具参数。重试必须保持同键、同参数、同状态；状态冲突后重新查询并换键。同用户同键不同参数或不同连接明确拒绝。资金转账、借贷还款、资产估值和绝对余额录入保留原业务语义。

draft 返回 operationId、pending、confirmationUrl；用户在网站审阅影响后确认或取消，Agent 用 `operation_get` 查询最终结果。confirmed=true 不能绕过确认。提交重新检查权限、过期/撤销、账目版本、归属和业务规则。写入记录与业务修改在同一 Serializable 事务提交，失败回滚。MCP 到期计划按批事务执行，REST 原逐计划执行语义保留。

私有图标使用 `file_upload_request(kind=icon)` → 同一 Bearer multipart 上传 file → `file_status` → `icon_publish`。最多 2 MiB，入口十分钟有效，绑定用户和连接。`icon_image` 返回同一 Bearer 保护的短期图片入口。MCP 不发行备份文件入口。

贵金属 `metal_holding_create` 无需填写市场金额；metalCostPerGram 可省略或 null。没有报价时 valuationAvailable=false，总额 complete=false 且包含 missingValuations。成本按实物重量计算，新持仓价值按重量×每克参考报价计算，既有持仓历史系数保留，盈亏由共享服务计算。metal_configure 省略成本保留旧值，null 清除。创建与配置均不接受 metalPurity 参数，新持仓使用默认比例 1；既有持仓的历史比例不改写。

## 已验证客户端

真实验证官方 `@modelcontextprotocol/sdk@1.31.0` 的 StreamableHTTPClientTransport：Bearer、OAuth 发现/DCR/PKCE、轮换、撤销与业务操作。精确锁定 v1 SDK，默认协议 2025-11-25。[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)、[授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。

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

OAuth 客户端使用 authProvider，浏览器回调后 finishAuth(code) 再连接；真实 provider 示例在 `apps/api/test/mcp.test.ts` 第三组。客户端安全保存 verifier、注册和令牌，禁止跨用户共享。

```powershell
$env:MCP_SERVER_URL='http://localhost:3100/mcp'
# 在终端安全设置 MCP_ACCESS_TOKEN，不写入仓库或聊天。
pnpm --filter @worthpath/api mcp:probe
Remove-Item Env:MCP_ACCESS_TOKEN
```

未验证 MCP Inspector、Claude、ChatGPT、Cursor、Codex 等商业客户端的配置和 OAuth 实际行为，不提供推测配置。生产 HTTPS 代理未部署验证。

## 启动与部署

```powershell
cd E:\WorthPath
.\scripts\pnpm.ps1 install
# 生成 Prisma 前暂停 API，Windows 会锁定引擎 DLL。
.\scripts\pnpm.ps1 db:generate
.\scripts\pnpm.ps1 db:migrate
.\scripts\pnpm.ps1 dev
```

| 环境变量            | 本地示例                  | 用途                                 |
| ------------------- | ------------------------- | ------------------------------------ |
| MCP_PUBLIC_URL      | http://localhost:3100/mcp | 规范资源 URL，路径必须 /mcp          |
| MCP_WEB_URL         | http://localhost:5173     | 网页授权及草稿确认入口               |
| MCP_ALLOWED_ORIGINS | http://localhost:5173     | 精确 Origin 列表，逗号分隔，无通配符 |

本次没有新增环境变量。保留本机 .env；示例不含凭据。生产必须 HTTPS、COOKIE_SECURE=true、准确 WEB_ORIGIN。Host 匹配规范资源；带 Origin 的请求匹配白名单，无 Origin 的非浏览器客户端允许接入。不得用任意转发头构造授权地址。

服务采用无状态 Streamable HTTP，请求结束关闭 transport/server；不共享用户认证上下文，不支持长期 GET SSE 或持久会话。代理转发规范 Host，禁用 MCP 响应缓冲，超时建议 330 秒；同时代理 /.well-known/、/authorize、/token、/register、/revoke 和 /api/。网站备份上传上限 512 MiB，ZIP 解压总计 1 GiB，代理配置对应 body 限制。日志不能保存 Authorization、密码、令牌或上传正文。

当前实际通过前后端类型检查/构建、34 项单元测试、18 组 REST/MySQL、4 组官方 SDK 测试。24 项迁移已 deploy；17 张表、159 个字段注释完整。未部署或推送。
