# WorthPath

个人资产负债与净资产管理。NestJS + React/Vite + TypeScript + MySQL，支持手机和电脑。Node.js 22.12+、pnpm 11、MySQL 8+。

```powershell
pnpm install
if (!(Test-Path apps/api/.env)) { Copy-Item apps/api/.env.example apps/api/.env }
# 仅在本地 .env 设置 DATABASE_URL，先检查数据库是否存在
pnpm db:generate
pnpm db:migrate
pnpm --filter @worthpath/api icons:seed # 追加预置共享图标，重复执行不覆盖已有记录
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

当前功能：注册登录和退出、资产/负债账户、独立资产、独立债务和关联、分钟余额历史与更正、隐藏项目密码核验、本位币和自动日汇率、净资产趋势和变化归因、分文件 ZIP 备份与事务追加恢复、侧栏及无操作退出设置、安全清空本账号数据。

金额原币保留，金额/汇率使用十进制字符串和 MySQL Decimal。归档只停止金额编辑，仍参与统计；需要归零时先更新余额。每次金额更新新增独立历史，同日按记录顺序保留；每日趋势使用当日最后余额，已有错误记录可单独更正。币种与资产负债属性创建后固定。详情同时显示原币和本位币金额。

汇率使用 [Frankfurter 公共日汇率 API](https://frankfurter.dev/)。请求使用固定币种表，不发送用户选择、身份或金额。进程运行时每小时检查，每天尝试一次；添加项目、修改本位币会重新触发检查。失败保留原币和历史汇率，显示缺失或实际使用日期，可以点击重试。自动更新保留已有同日历史导入汇率。首次使用不会自动补齐早期历史汇率，缺失日期不绘制完整总额；原币和已有汇率始终保留。

新版 ZIP 备份不限制记录条数，导入先预览、再明确确认。首版只追加新项目并重建关系，不覆盖已有项目；按项目 ID 和导入来源识别重复；同日汇率冲突会拒绝整次导入。已有本位币保留，空空间恢复备份本位币。文件包含财务数据，应由用户妥善保存。

设计见 [数据模型与结构](docs/architecture.md)，已验证范围与后续工作见 [首版验收](docs/acceptance.md)。生产需要 HTTPS、COOKIE_SECURE=true、WEB_ORIGIN 为准确站点地址；前端构建由反向代理托管并代理 /api。API 生产启动：在 `apps/api` 中执行 `node dist/main.js`。生产认证限速需迁移到共享存储，数据库用户需最小权限，部署与运行监控尚未配置。

备份下载为 ZIP：manifest、settings、currencies、accounts、assets、debts、history、links、rates、icons 各一个 JSON 文件，包含隐藏项目及全部历史，不含密码或会话凭据。导入先上传并预览，再确认追加；旧 JSON 备份继续兼容。不限制项目、历史、关联或汇率条数；上传文件最大 512 MB，ZIP 解压总计最大 1 GB，用于保护服务器资源。

内网穿透临时测试：本地 `apps/api/.env` 可设置 `WEB_ORIGIN=*` 并重启 API，允许来自任意 HTTP/HTTPS 站点的浏览器写入请求，仍需登录身份并校验数据归属。缺失或无效 Origin 仍拒绝；`NODE_ENV=production` 禁止此通配符。测试结束后恢复准确的站点地址。

账户图标：新增或编辑账户时选择可复用图标；设置页面提供图标库及中文名称搜索。直接上传默认私有，仅当前用户能检索、读取和使用；勾选共享并明确确认公开后，所有登录用户均可搜索复用，名称必须包含中文。支持静态 PNG/JPG/WebP，单张最大 2 MB，转为最长边 256 像素的 PNG 并去除图片元数据。同一用户相同图片和可见范围会复用现有图标。账户图标通过外键关联，不复制图片。

预置 17 家银行及支付宝、微信、京东金融共 20 个图标，资源及来源清单在 `apps/api/assets/icons`；银行来自公开银行标识库，支付平台来自官方网站资源。图标版权与商标归相应品牌所有，用于识别账户，不代表品牌合作或授权。运行 `pnpm --filter @worthpath/api icons:seed` 初始化共享库，不会覆盖已有图标。可离线使用已提交的 PNG，无需访问外部图标网站。

ZIP 格式 v4 增加 icons.json（图标名称、图片、内容校验值），包含自己的全部图标及账户引用的共享图标。导入会重建关联并将图标恢复为私有，相同图片复用，避免自动公开；旧 v3 ZIP 和旧 JSON 仍可导入。清空个人数据会删除私有图标，已发布共享图标保留供其他用户使用。
