# 2026-10-04 Agent、备份与界面更新

本次按 update.md 和聊天补充要求完成。MCP 工具由 49 个调整为 39 个；敏感操作与汇率、贵金属报价修改退出 MCP 范围。该范围变更取代最初的全部业务 MCP 覆盖要求，网站原业务入口保留。

## 用户使用

进入「设置与备份 → 连接 Agent」。默认仅显示服务地址与复制教程，其他内容分为「权限与工具」「连接管理」「操作记录」。教程、SDK 配置与个人令牌表单按需展开。工具清单来自实际后端注册内容。复制教程不会包含密码或令牌。

OAuth 授权选择只读、草稿修改或直接写入；个人令牌创建也选择相同三档。read 为必需基础权限；draft 与 write 互斥。隐藏账户读取与修改为独立附加授权，默认关闭；修改还要求读取权限及 draft/write。网页解锁不会自动授予 Agent。旧全局策略入口及运行时判断已移除；已有 write 连接现在直接执行普通修改，如需草稿应撤销并重新授权 read draft。

个人令牌期限为 1、3、7、30、365 天或永久；只展示一次完整值，数据库保存摘要。永久令牌每次请求检查资源与撤销；内部会话有界续期。OAuth 仍使用一小时访问令牌和三十天刷新授权，刷新轮换。实际接入步骤、环境示例和经过验证的官方 SDK 配置见 [MCP 接入](mcp.md)。

贵金属手动报价入口已从网页、REST 与 MCP 删除。创建、编辑和 MCP Schema 也不再提供纯度输入，新持仓按默认比例 1 估值；保留已有比例、报价来源及历史金额，不静默改写既有账目。重量、可选买入成本、盈亏、自动估值和网站报价刷新保留。账户卡片不重复显示分组徽标，分组标题、筛选与排序保留。

## 仅支持当前 ZIP v9

网站「备份与恢复」下载新的 ZIP，并通过上传预检、影响预览、确认追加恢复。单文件 JSON（包括 v3）全部拒绝；ZIP v3–v8 也拒绝，不保留补字段、缺文件回退或版本分支。旧 /api/backup/import 与 /api/backup/preview JSON 路由删除；仅保留 /api/backup、/upload、/import-file 与原清空资格流程。

ZIP 内仍有可读 JSON 数据文件及校验摘要，但不能将单文件 JSON 作为备份上传。manifest version=9，所有当前文件、设置和元数据必须完整。上传 512 MiB、解压总计 1 GiB；文件绑定用户与会话、十五分钟失效。预检失败删除临时上传；正式恢复冲突或失败在事务中回滚。

升级前导出的旧备份无法再导入，请从升级后的网站重新导出。此次没有删除用户保存的备份文件，也没有改写财务记录。备份操作仅在网站完成，MCP 不提供导出、恢复或备份上传。

## 迁移、文件与启动

两项新增迁移已在本机 MySQL 应用：

- 20261004090000_agent_permanent_tokens：AgentGrant.expiresAt 可为空，表示可撤销的永久 PAT。
- 20261004103000_agent_connection_permissions：更新权限字段及已停用策略表的说明，不删除旧策略行。

自动审批拒绝了 DROP TABLE 和批量取消待确认操作的提案，原因是具体数据副作用未获授权。因此采用保留原数据的实现；历史 AgentPolicy 表不参与权限判断，已撤下工具的旧草稿无法提交。未执行 reset、drop 或批量取消。

当前 24 项迁移状态最新；17 张表（含 Prisma 迁移表）、159 个字段注释全部核验通过。核验清单在 [database-comments.json](database-comments.json)。无新增环境变量、无新依赖、无硬编码数据库或授权凭据。

主要修改文件组：

- API：backup.ts、backup-format.ts、zip.ts、metals.ts、openapi.ts。
- MCP：catalogue.ts、oauth.ts、operations.ts、files.ts、management.ts、transport.ts、information.ts。
- 网页：AgentConnections.tsx、MetalPanel.tsx、App.tsx、style.css 及两份翻译字典。
- 数据：Prisma Schema 和两项迁移。
- 测试：ZIP、MCP、贵金属与设置及所有使用备份恢复的 REST 测试；backup-fixture.ts 将测试数据打包成 ZIP，实际调用上传/确认 API，没有调用已删除 JSON 路由。

```powershell
cd E:\WorthPath
# 暂停 API 后生成客户端；保留现有 apps/api/.env。
.\scripts\pnpm.ps1 db:generate
.\scripts\pnpm.ps1 db:migrate
.\scripts\pnpm.ps1 dev
```

现有开发地址 http://localhost:5173，MCP http://localhost:3100/mcp。本次隔离回归用 3101/3102；临时测试服务完成后关闭。没有修改本机 .env，没有部署或推送。README、update.md 原有删除及 Vite 的用户修改保持未提交，只提交与此次功能直接相关的文档更改。

## 实际验证

- 前后端 typecheck 与生产 build 通过。
- 34 项单元测试通过：精确金额、历史重放、行情失败保留、完整 ZIP 校验、旧版本拒绝、大量记录、无缺字段回退。
- 18 组真实 REST/MySQL 通过：全部原业务、配对余额、历史、计划、隐私、设置和 ZIP 恢复；实际上传 JSON v1/v2/v3/v9 都返回 400，旧 JSON 路由返回 404，目标数据不变。
- 4 组官方 SDK 1.31.0 MCP 测试通过：39 工具、初始化/发现/调用、普通写入和草稿、幂等/并发/回滚、只读拒绝写入、隐藏读取不授予修改、永久令牌会话续期、期限和撤销、资源/来源限制、OAuth DCR/PKCE/一次性码/轮换及越范围授权拒绝。
- 临时账户真实浏览器验证：默认页面分区、折叠表单、固定期限、三档权限、隐藏权限默认关闭、复制教程成功提示、账户卡片无分组徽标，贵金属新增与编辑无纯度或手动报价输入。截图在工作区外的验证目录，docs 不保存图片；临时用户及虚构账户清理。

没有验证商业 Agent 配置、MCP Inspector 或生产 HTTPS 反向代理；未声称所有客户端兼容。外部行情供应商实时可用性不作为本次通过条件。完整当前功能覆盖与撤下项见 [覆盖矩阵](mcp-coverage.md)。
