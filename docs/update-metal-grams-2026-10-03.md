# 贵金属克数与数据库注释更新

独立资产新增弹窗选择「贵金属」后，填写黄金/白银、克数、纯度、原币和业务时间，无需填写金额或市场单价。默认随参考价自动估值；没有有效报价时为「待估值」，总览提示不完整，不把未知价值作为已知零值。后续自动/手动报价继续沿用现有 MetalsService 和历史逻辑。

买入价为可选的每克实物成本（原币）。成本 = 总克数 × 买入价；估值 = 总克数 × 纯度 × 对应币种纯金属每克报价；盈亏 = 当前估值 − 成本。全程 Decimal，金额 8 位小数四舍五入；每克成本最多 12 位整数、12 位小数且必须大于零。它是估值盈亏，不包含未记录的税费/已实现卖出收益。省略或清空价格不显示盈亏，缺少估值时盈亏待定。旧贵金属资产可在详情补充成本。

## 服务、备份和 MCP

REST POST /api/metals/holdings 与 MCP metal_holding_create 共用 MetalsBusinessService.create；无需 amount。现有 PUT /api/metals/:id 与 metal_configure 接受可选 metalCostPerGram，省略保留、null 清除。position 查询返回 valuationAvailable、metalCost、metalProfit。前端只展示服务端结果，不以 Number 计算盈亏。

ZIP v8 增加可选成本字段，既有备份缺少字段仍可验证恢复；配置、成本和估值历史保持用户隔离。新 MCP 工具遵循服务端草稿、确认、幂等与并发规则，工具总数为 49。

## 迁移和启动

- 20261003120000_metal_cost：Position 增加可空 DECIMAL(24,12) metalCostPerGram，附中文字段注释，不回填未知成本。
- 20261003130000_migration_comments：为 Prisma 自己的迁移表和 8 个字段补齐注释，保持实际类型、可空性和默认值。
- 前一 MCP 提交已新增 20261003090000_agent_access、20261003100000_agent_audit、20261003110000_agent_comments。

全部 migration deploy 已在当前 MySQL 实际执行，累计 22 个迁移。scripts/check-comments.cjs 验证所有 17 张表、159 个字段均有注释，清单见 database-comments.json。无新增环境变量；启动命令见 [MCP 文档](mcp.md)。先暂停 API，再 db:generate、db:migrate，然后 dev；不使用 reset。

## 实际验证

- 前后端 typecheck/build 通过。
- 36 项单元测试通过：待估值完整性、精确克数成本、行情/失败回退、原计算和 ZIP 等。
- 18 组真实 REST/MySQL 测试通过：无价格克数创建、拥有报价创建、精确盈亏、成本保留/清除、外用户拒绝、无效克数拒绝、新备份恢复和旧备份兼容，以及原业务回归。
- 3 组官方 SDK/MySQL MCP 测试通过：包含新增克数工具真实写入和查询；原 OAuth、确认、幂等、并发与失败回滚继续通过。
- 登录后的新增弹窗尚未通过浏览器人工端到端验证：自动审批拒绝临时测试账号登录，等待用户授权。已有 MCP 管理页在前一阶段已浏览器验证。无其他商业 Agent 客户端或生产代理部署验证。

本次不部署、不推送、不改本地 .env，也不把图片保存进 docs。
