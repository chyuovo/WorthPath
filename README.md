# WorthPath

个人资产负债与净资产管理。NestJS + React/Vite + TypeScript + MySQL，支持手机和电脑。Node.js 22.12+、pnpm 11、MySQL 8+。

```powershell
pnpm install
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
# 仅在本地 .env 设置 DATABASE_URL，先检查数据库是否存在
pnpm db:generate
pnpm db:migrate
pnpm --filter @worthpath/api build
pnpm --filter @worthpath/api icons:seed # 幂等初始化或更新内置图标，保留用户上传和财务数据
pnpm dev
```

前端 http://localhost:5173，API http://localhost:3100/api。若命令行找不到 pnpm，本机可用项目启动器；它优先使用已安装的 pnpm，随后检查 Codex 随附版本，不修改 PATH：

```powershell
cd E:\WorthPath
.\scripts\pnpm.ps1 dev
```

已有本地环境配置时直接启动，避免重新复制模板。创建数据库前可以在 `apps/api` 中执行 `node scripts/db-preflight.cjs`；脚本先检查同名数据库，仅在不存在时创建空数据库，不删除已有数据。迁移只使用 `migrate deploy`。Windows 上重新生成 Prisma 客户端前需停止 API，以释放其 DLL。

```powershell
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration # 需先启动 API；只创建并清理随机命名的临时测试用户
pnpm db:status
pnpm check:staged # git add 后，提交前检查本地凭证和禁止提交的文件
```

当前功能：注册登录和退出、资产/负债账户、独立资产、独立债务和关联、分钟余额历史与更正、隐藏项目密码核验、本位币和自动日汇率、净资产趋势和变化归因、分文件 ZIP 备份与事务追加恢复、各菜单项显示开关、统一备注显示开关及无操作退出设置、安全清空本账号数据。

金额原币保留，金额/汇率使用十进制字符串和 MySQL Decimal。归档只停止金额编辑，仍参与统计；需要归零时先更新余额。每次金额更新新增独立历史，同日按记录顺序保留；每日趋势使用当日最后余额；已有错误记录可单独更正，转账及其之前的历史需通过新增余额调整修正，避免破坏双方一致性。币种与资产负债属性创建后固定。详情同时显示原币和本位币金额。

汇率使用 [Frankfurter 公共日汇率 API](https://frankfurter.dev/)。请求使用固定币种表，不发送用户选择、身份或金额。进程运行时每小时检查，每天尝试一次；添加项目、修改本位币会重新触发检查。失败保留原币和历史汇率，显示缺失或实际使用日期，可以点击重试。自动更新保留已有同日历史导入汇率。首次使用不会自动补齐早期历史汇率，缺失日期不绘制完整总额；原币和已有汇率始终保留。

新版 ZIP 备份不限制记录条数，导入先预览、再明确确认。首版只追加新项目并重建关系，不覆盖已有项目；按项目 ID 和导入来源识别重复；同日汇率冲突会拒绝整次导入。已有本位币保留，空空间恢复备份本位币。文件包含财务数据，应由用户妥善保存。

设计见 [数据模型与结构](docs/architecture.md)，已验证范围与后续工作见 [首版验收](docs/acceptance.md)。生产需要 HTTPS、COOKIE_SECURE=true、WEB_ORIGIN 为准确站点地址；前端构建由反向代理托管并代理 /api。API 生产启动：在 `apps/api` 中执行 `node dist/main.js`。生产认证限速需迁移到共享存储，数据库用户需最小权限，部署与运行监控尚未配置。

备份下载为 ZIP：manifest、settings、currencies、accounts、assets、debts、history、links、rates、icons、transfers 各一个 JSON 文件，包含隐藏项目及全部历史，不含密码或会话凭据。导入先上传并预览，再确认追加；旧 JSON 备份继续兼容。不限制项目、历史、关联或汇率条数；上传文件最大 512 MB，ZIP 解压总计最大 1 GB，用于保护服务器资源。

内网穿透临时测试：本地 `apps/api/.env` 可设置 `WEB_ORIGIN=*` 并重启 API，允许来自任意 HTTP/HTTPS 站点的浏览器写入请求，仍需登录身份并校验数据归属。缺失或无效 Origin 仍拒绝；`NODE_ENV=production` 禁止此通配符。测试结束后恢复准确的站点地址。

账户图标：新增或编辑账户时选择可复用图标；设置页面提供图标库及中文名称搜索。直接上传默认私有，仅当前用户能检索、读取和使用；勾选共享并明确确认公开后，所有登录用户均可搜索复用，名称必须包含中文。支持静态 PNG/JPG/WebP，单张最大 2 MB，转为最长边 256 像素的 PNG 并去除图片元数据。同一用户相同图片和可见范围会复用现有图标。账户图标通过外键关联，不复制图片。

预置 17 家银行及支付宝、微信、京东金融共 20 个图标，资源及来源清单在 `apps/api/assets/icons`；银行来自公开银行标识库，支付平台来自官方网站资源及 Simple Icons。图标版权与商标归相应品牌所有，用于识别账户，不代表品牌合作或授权。运行 `pnpm --filter @worthpath/api icons:seed` 初始化共享库或更新固定 ID 的内置透明图标，不修改用户上传图标或财务数据。可离线使用已提交的 PNG，无需访问外部图标网站。

ZIP 格式 v5 增加 transfers.json（转账双方、金额、手续费及配对历史），包含完整转账恢复关系。icons.json（图标名称、图片、内容校验值），包含自己的全部图标及账户引用的共享图标。导入会重建关联并将图标恢复为私有，相同图片复用，避免自动公开；旧 v3/v4 ZIP 和旧 JSON 仍可导入。清空个人数据会删除私有图标，已发布共享图标保留供其他用户使用。

## 账户转账与显示设置

账户页面和账户详情提供“账户间转账”，详情自动选择当前账户。双方余额和历史在同一数据库事务中更新；正手续费额外扣除，负手续费表示优惠（绝对值不超过本金），同币种到账金额等于转出金额，跨币种填写实际到账金额。转账不调用银行或支付平台，不执行真实资金划转。重复提交使用请求 ID 防止重复记账，并发写冲突有限重试。转账时间不能早于双方最新余额；后续余额调整不能插入已有配对操作之前。

债务分为借入（应付负债）和借出（应收资产），支持借入到账、借出付款、收回应收和偿还应付。账户与债务在同一事务中记账并自动关联；双方详情和往来记录可互相导航。已有债务可录入剩余余额，新发生借贷可先建零余额债务再使用联动操作。ZIP v6 保留操作类型，兼容旧 v3/v4/v5 ZIP 和 v1/v2 JSON。

支持简中、English、繁中，在登录页或顶部切换，语言保存在当前浏览器。用户名称和备注保留原文。账户/资产/债务按页查询当前余额，历史和往来使用最多 100 条的游标分页；趋势默认最近 90 天，支持日、周、月。查询实现、迁移步骤、实测性能和验证边界见 [性能与联动验收](docs/performance.md)。

设置分类使用下拉菜单；资产总览、账户、独立资产、债务、变化记录分别使用显示开关，设置入口始终保留。顶部重复导航已移除。“显示备注”关闭后隐藏列表、详情与表单备注，原有备注不删除，备份仍完整包含。图标通过弹窗检索、选择或上传，透明背景显示；接近纯白的背景像素会转为透明，彩色背景需上传透明 PNG。

“清空本账号数据”以红色显示。先下载当前完整备份并确认已保存，再输入“确定清空”，依次完成两次确认弹窗；第一次取消在左、确认在右，第二次确认在左、取消在右，两次默认聚焦取消。服务端仍校验当前登录身份、近期备份凭据及数据完整性，财务数据发生变化后须重新下载备份。

## OpenAPI / Swagger

启动开发服务后可访问：

- Swagger 交互文档：[http://localhost:5173/api/docs](http://localhost:5173/api/docs)
- OpenAPI JSON：[http://localhost:5173/api/openapi.json](http://localhost:5173/api/openapi.json)
- 后端直连文档：[http://localhost:3100/api/docs](http://localhost:3100/api/docs)

```powershell
Invoke-RestMethod http://localhost:5173/api/openapi.json
```

接口定义由实际控制器路由和表单校验模式生成。文档本身不包含用户财务数据；除注册、登录及健康检查外，业务接口需登录会话 Cookie。建议先在同一站点登录，再通过前端代理地址使用文档；写入接口仍受来源校验和数据隔离约束。部署时将上述地址中的主机替换为自己的站点，并将 `/api` 代理到后端。实现使用 [NestJS Swagger](https://docs.nestjs.com/openapi/introduction)。
