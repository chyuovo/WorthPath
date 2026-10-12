# WorthPath

**把账户、资产与负债汇聚成一条清晰的净资产轨迹。**

WorthPath 是一个支持自托管的个人资产、负债与净资产管理应用。它将多币种账户、信用卡、独立资产和借贷往来集中管理，提供快速记账、双边转账与还款、收支日历、贵金属估值和净资产趋势，并支持通过 OAuth / MCP 连接 AI 助手。基于 NestJS、React、TypeScript 和 MySQL 构建，适配手机与电脑，可使用 Docker 部署。

[快速开始](#快速开始) · [Docker 部署](docker.md) · [连接 AI 助手](#连接-ai-助手) · [文档索引](#文档索引)

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 账户与分组 | 管理资产账户、信用卡和贷款，自定义分组与排序，支持透支及信用卡溢缴余额 |
| 独立资产 | 记录现金、房产、车辆、贵金属、纪念币和纪念钞；手动估值或按贵金属克数估价 |
| 借入与借出 | 管理应付负债与应收资产，记录借入到账、借出付款、收回应收及偿还应付 |
| 快速记账 | 紧凑卡片更新余额，查看本次操作并逐项撤回，筛选当天已有实际记录的账户 |
| 转账与还款 | 同币种或跨币种双边记账，支持手续费、还款优惠和月份还款标记 |
| 净资产趋势 | 查看总资产、总负债、净资产及余额历史，支持日、周、月粒度与独立折线开关 |
| 收支日历与计划 | 按日查看账户变化估算的收支，配置按需执行的支出和转账计划 |
| 多币种与估值 | 保留原币金额，按本位币汇总；公共日汇率和黄金、白银参考价支持自动更新 |
| 隐私与显示 | 隐藏项目、密码解锁、单项统计开关、自选总览卡片、备注和菜单显示设置 |
| 备份与恢复 | 完整 ZIP v9 备份，包含隐藏项目、历史、图标和配对往来；导入先预览再确认 |
| AI 助手接入 | OAuth / MCP 授权，分别提供只读、网页确认草稿和直接写入权限 |
| 多用户与界面 | 管理员创建账号、角色与封禁管理；简中、繁中、English，浅色/深色及移动端适配 |

WorthPath 记录和整理账目。转账、还款、借贷和定时计划仅更新应用内的数据，不执行真实资金划转。收支日历由账户余额变化估算，排除内部转账、借贷本金和初始余额。

## 技术栈与目录

- **前端**：React 19、Vite 7、TypeScript、Lucide 图标。
- **后端**：NestJS 11、Prisma 6、MySQL 8+、Zod。
- **金额计算**：Decimal.js 与 MySQL Decimal；API 使用十进制字符串传递金额和汇率。
- **助手接入**：MCP Streamable HTTP、OAuth、PKCE。
- **部署**：pnpm workspace；Docker 将前后端打包为一个应用容器。

```text
WorthPath/
├── apps/
│   ├── api/                 # 后端、Prisma 迁移、测试和内置图标
│   └── web/                 # 前端页面、国际化和界面测试
├── docs/                    # 架构、配置、验收和更新文档
├── scripts/                 # 开发启动器与提交检查
├── Dockerfile               # 前后端合并镜像
├── compose.yaml             # 应用服务、网络与图标持久化配置
├── .env.production.example  # 生产环境模板
└── docker.md                # Docker 部署与更新说明
```

## 快速开始

### 1. 准备环境

需要 Node.js 22.12+、pnpm 11 和可连接的 MySQL 8+。项目锁定 pnpm **11.19.0**，Docker 镜像使用 Node.js 24。

以下本地开发示例使用 PowerShell，在项目根目录执行：

```powershell
git clone https://github.com/chyuovo/WorthPath.git
cd WorthPath
pnpm install

# 已有配置时保留，避免覆盖
if (!(Test-Path apps/api/.env)) {
    Copy-Item apps/api/.env.example apps/api/.env
}
```

### 2. 配置数据库与管理员

编辑 `apps/api/.env`，至少设置数据库连接和初始管理员凭据：

```dotenv
DATABASE_URL="mysql://USER:PASSWORD@HOST:3306/worthpath"
ADMIN_USERNAME=admin
ADMIN_PASSWORD=REPLACE_WITH_A_STRONG_PASSWORD
```

将占位值替换为实际配置，密码中的特殊字符需要 URL 编码。完整选项见 [开发配置模板](apps/api/.env.example) 和 [网络配置说明](docs/network-settings.md)。真实环境文件不要提交到 Git。

先准备数据库。也可使用以下预检查脚本：已有数据库只检查；仅在不存在时创建空数据库，需要数据库账号具备相应权限。

```powershell
Push-Location apps/api
node scripts/db-preflight.cjs
Pop-Location
```

### 3. 迁移、初始化与启动

确认数据库地址正确；已有数据先备份。依次执行，前一步失败时先解决错误：

```powershell
pnpm db:generate
pnpm db:migrate
pnpm --filter @worthpath/api build
pnpm --filter @worthpath/api icons:seed
pnpm dev
```

`icons:seed` 幂等初始化或更新内置图标，保留用户上传图标和财务数据。迁移入口按依赖顺序执行 Prisma `migrate deploy`；不要用 `db push` 或数据库重置替代迁移。历史空库迁移失败的恢复见 [数据库迁移说明](docs/database-migrations.md)。Windows 重新生成 Prisma 客户端前需停止 API，以释放 DLL。

| 入口 | 默认地址 |
| --- | --- |
| 网页 | <http://localhost:5173> |
| API | <http://localhost:3100/api> |
| Swagger 文档（前端代理） | <http://localhost:5173/api/docs> |
| OpenAPI JSON | <http://localhost:5173/api/openapi.json> |
| 本机 MCP 服务 | <http://localhost:3100/mcp> |

首次登录必须修改初始密码，新密码至少 10 个字符、最多 72 字节。已有本地配置和已迁移数据库时，直接运行 `pnpm dev`。

Windows 找不到 pnpm 时，可使用项目启动器。它优先使用已安装的 pnpm，其次检查 Codex 随附版本，不修改 PATH：

```powershell
.\scripts\pnpm.ps1 dev
```

### 4. 创建自己的账目

1. 登录并完成首次改密，设置本位币。
2. 添加账户、独立资产或债务，填写当前余额或估值。
3. 使用快速记账、转账、还款或借贷联动记录变化。
4. 在总览和日历查看净资产轨迹与每日变化，按需下载完整备份。

## Docker 部署

前后端运行在同一个容器，同一端口提供网页、`/api`、`/mcp` 和 OAuth。当前 `compose.yaml` 只管理应用，使用已有 MySQL 和外部 Docker 网络 `worthpath`，不创建数据库。

部署前准备生产环境文件、MySQL、外部网络、图标目录与 HTTPS 反向代理。完整步骤、镜像构建/传输、迁移、更新和回退说明见 [docker.md](docker.md)；生产配置参考 [.env.production.example](.env.production.example)。

- 应用端口默认绑定 `127.0.0.1:3100`，由反向代理对外提供 HTTPS；代理需覆盖全部应用路径。
- 图标持久化：宿主机 `/opt/worthpath/data/icons` → 容器 `/app/data/icons`，目录需允许容器 UID/GID 1000 读写。
- 数据库继续保存图标内容，用于自包含 ZIP 备份及文件缺失修复；服务器备份应包含 MySQL 和图标目录。
- 更新已有部署时同步 Compose 挂载配置并重建镜像，具体操作见部署文档。
- 上线需设置准确的 Host/Origin、启用 `COOKIE_SECURE=true` 并关闭开发环境开放开关。显式配置优先于 `NODE_ENV`，仅改为 `production` 不会收紧已有配置。

非 Docker 部署可构建网页静态文件，通过反向代理托管并代理 API；后端在 `apps/api` 执行 `node dist/main.js`。当前认证限流使用进程内存，多实例部署前需完善共享限流、代理信任与调度策略；运行监控需自行配置。

## 账号与隐私

公开注册已关闭，账号由管理员后台创建。初始管理员仅在数据库没有管理员时建立；未配置凭据时默认 `admin/admin`，不会覆盖已有管理员密码或提升同名普通用户权限。若同名用户冲突，需设置其他初始管理员用户名。

管理员可创建账号、设置管理员/普通用户/只读角色、封禁与解除封禁。账号数据按用户隔离，管理员角色不授予查看其他用户财务数据的能力。角色或封禁变化会撤销该用户全部登录会话和 MCP 授权；只读用户不能写入业务数据或创建修改草稿。

删除账号仅支持默认 `admin` 管理员，需另一位已完成改密的管理员操作并完成验证，且必须保留一位可用管理员。删除清理该账号私人数据及授权，共享图标保留。详情见 [管理员功能说明](docs/admin-accounts.md)。

隐藏项目可要求再次验证密码；网页解锁与 MCP 隐藏账户授权分别管理。关闭备注显示不删除备注，完整备份仍包含隐藏项目和备注。清空个人数据须先下载并保存当前完整备份，再输入“确定清空”并完成两次确认；账目变化后需重新下载备份。

## 金额、历史与备份规则

- **多币种**：保留原币，详情同时显示原币和本位币。缺少汇率或估值时明确提示不完整，趋势保留断线。
- **余额历史**：每次金额更新新增独立记录，同日按顺序保留；每日趋势使用当日最后余额。业务日期与时间采用 UTC+8。
- **统计范围**：支持单项计入开关；归档仅停止金额编辑，仍参与统计。币种及资产/负债属性创建后固定。
- **配对往来**：转账与借贷双方余额及历史在同一数据库事务中更新，重复提交使用请求 ID 防止重复记账。配对记录按整笔操作编辑或撤销；历史调整规则见更新与验收文档。
- **定时计划**：打开账户页时按需执行，每批最多 20 项；不代表后台持续运行的支付任务。
- **备份范围**：当前仅支持完整 **ZIP v9**，包含全部项目、隐藏项目、历史、关系、汇率、图标和转账，不包含密码或会话凭据。旧 ZIP 和单文件 JSON 均不支持。
- **恢复方式**：先上传预览，再确认追加新项目并重建关系，不覆盖已有项目；按项目 ID 与导入来源识别重复，同日汇率冲突拒绝整次导入。已有空间保留本位币，空空间恢复备份本位币。
- **文件限制**：不限制项目及记录条数；上传最大 512 MB，ZIP 解压总计最大 1 GB。恢复图标默认私有，相同图片复用。

## 连接 AI 助手

在设置中的“连接助手”复制实际 MCP 地址与接入提示词，在客户端配置服务并完成网页授权。远程接入需设置客户端可访问的 `MCP_PUBLIC_URL` 和 `MCP_WEB_URL`；`localhost` 仅代表客户端本机。

| 权限 | 普通修改行为 |
| --- | --- |
| 只读 | 查询账户、余额、资产、负债、历史等数据 |
| 草稿修改 | 创建修改草稿，由本人在网页审阅确认后生效 |
| 直接写入 | 在授权范围内直接执行普通业务写入 |

隐藏账户的读取与修改单独授权，可选择授权期限，在“我的连接”调整权限或撤销连接。连接后先发现实际工具，并核对一次 `connection_info` 返回的当前资源和权限；重连、权限变更或授权错误后重新核对。申请权限和旧聊天记录不代表当前授权。

写入前使用 `state_get` 获取状态，随操作提交 `expectedState` 和唯一 `idempotencyKey`；同一次网络重试复用完全相同的参数和键。返回 `pending` 时由用户通过 `confirmationUrl` 审阅，再查询 `operation_get`，不能将待确认草稿视为已完成。

密码修改、清空数据、备份导出/恢复、共享图标发布、汇率及贵金属报价编辑保留在网站完成，MCP 不提供这些操作。接入流程、协议和验证边界见 [MCP 文档](docs/mcp.md) 与 [功能覆盖矩阵](docs/mcp-coverage.md)。

## API 文档与开发检查

启动后可访问 `/api/docs` 与 `/api/openapi.json`，后端直连地址为 <http://localhost:3100/api/docs>。接口定义由实际控制器路由与校验模式生成；业务接口需登录会话 Cookie，建议先登录网页，再通过同站前端代理访问交互文档。写入仍受来源校验与数据隔离约束。

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm db:status

# 需先启动 API；创建并清理随机命名的临时测试用户
pnpm test:integration

# 临时 MySQL 数据库与独立 API，包含管理员和 MCP 测试
# 需要创建、删除测试数据库的权限
pnpm --filter @worthpath/api test:isolated

# git add 后、提交前检查本地凭证及禁止提交的文件
pnpm check:staged
```

具体测试环境、已验证范围及性能数据以对应验收文档为准。

## 第三方接口与图标

| 来源 | 用途 | 请求与失败处理 |
| --- | --- | --- |
| [Frankfurter](https://frankfurter.dev/) | 公共日汇率，外币及贵金属美元报价换算 | 固定 USD 与 CNY/HKD/EUR/GBP/JPY/AUD/CAD/CHF/SGD 币种；每小时检查、每天尝试一次，失败保留原币与历史汇率 |
| [Gold API](https://gold-api.com/docs) | 黄金 XAU、白银 XAG 的美元/金衡盎司参考价 | 固定品种请求；按 31.1034768 克/金衡盎司换算，格式、时间或汇率异常时保留已有报价及估值 |

第三方行情请求由后端发起，无需密钥，不发送用户身份、账户、金额、持仓重量或登录 Cookie。网站支持手动刷新；已有同日历史导入汇率与报价保留。首次使用不自动补齐早期历史汇率。贵金属自动估价为可选项，开启后新增估值历史，不改写历史；参考价不包含工费、买卖价差或回收折价，报价日期随界面与备份保存。

图标库预置银行、支付平台及交易所等 36 个图标，PNG 与来源清单位于 `apps/api/assets/icons`。图标版权和商标归相应品牌，用于识别账户，不代表品牌合作或授权。

用户上传默认私有；共享发布须明确确认且名称包含中文。支持静态 PNG/JPG/WebP，单张最大 2 MB，转换为最长边 256 像素的 PNG 并去除元数据。内置图标通过 `icons:seed` 更新，后续维护直接修改 PNG 和 `sources.json`。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [Docker 部署](docker.md) | 镜像构建、环境配置、HTTPS、图标持久化、更新与回退 |
| [网络配置](docs/network-settings.md) | Host、Origin、HTTP/HTTPS、Cookie 与开发配置 |
| [数据库迁移](docs/database-migrations.md) | 迁移顺序、状态检查及历史失败恢复 |
| [架构与数据模型](docs/architecture.md) | 领域模型、金额计算、历史及权限；含历史版本说明 |
| [管理员账号](docs/admin-accounts.md) | 角色、封禁、默认管理员删除与验证 |
| [MCP 接入](docs/mcp.md) / [覆盖矩阵](docs/mcp-coverage.md) | 连接、授权、工具能力与验证范围 |
| [首版验收](docs/acceptance.md) / [性能与联动](docs/performance.md) | 历史验收记录、性能数据与验证边界 |
| [快速记账](docs/update-quick-entry-2026-10-04.md) / [项目删除](docs/update-position-deletion-2026-10-04.md) | 快速操作、撤回、还款与删除依赖 |
| [还款优惠与图表](docs/update-repayment-trend-2026-10-04.md) | 优惠、手续费与净资产趋势交互 |
| [连接权限与还款](docs/update-connections-repayment-users-2026-10-05.md) / [OAuth 权限缓存](docs/update-oauth-permissions-2026-10-05.md) | 当前授权与权限调整流程 |
| [现金、草稿审阅与登录](docs/update-cash-drafts-login-2026-10-05.md) / [草稿确认修复](docs/fix-mcp-create-drafts-2026-10-04.md) | 现金分类、批量草稿与登录偏好 |
| [移动端导航与当天筛选](docs/update-mobile-navigation-2026-10-07.md) | 当前导航、实际记账筛选、滚动条与无障碍适配 |

`docs` 中的更新与验收文档保留对应时间的实现记录，旧备份版本和旧界面说明属于历史信息；当前仅支持 ZIP v9。文档目录保存文字与结构化验收数据，不保存界面截图；应用图标保存在资源目录。

## 仓库维护

维护者可按需添加远程仓库，并将 GitHub 设为默认推送目标：

```powershell
git remote add github https://github.com/chyuovo/WorthPath.git
git remote add wyh https://git.mashiroart.xyz/chyuovo/WorthPath.git
git remote add gitee https://gitee.com/REMOTE_CY/worth-path.git
git remote add cy https://git.chyuovo.top/chyuovo/WorthPath.git
git config remote.pushDefault github

# 需要同步多个远程时手动执行
'github','gitee','wyh','cy' | ForEach-Object { git push $_ main }
```

账户工具栏、悬浮毛玻璃底栏与紧凑手机日历已更新，手机格内显示小字号收支金额（大额使用带近似标识的紧凑单位），日期详情显示完整金额；详见 [界面更新与验收](docs/update-glass-calendar-2026-10-08.md)。

Docker 默认使用 Gitea `latest` 镜像；本地构建推送后，服务器拉取并重建即可更新，见 [Gitea 镜像部署](docs/deploy-gitea-latest.md)。

手机毛玻璃底栏支持左右拖动高亮选择入口，松手切换，点击与键盘操作仍可用；见 [滑动底栏与日历金额说明](docs/update-swipe-tabbar-2026-10-08.md)。

编辑项目中的图标选择器使用原生嵌套模态弹窗，支持图标回填与取消，修复被外层模态框阻止交互的问题；见 [修复与验证](docs/fix-icon-picker-2026-10-12.md)。

净资产轨迹的纵轴仅根据可见折线缩放，日期标签与选择范围一致，并支持单日数据点；见 [趋势范围修复](docs/fix-trend-range-2026-10-12.md)。
