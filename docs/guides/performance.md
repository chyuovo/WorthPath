# 查询优化、关联记账与多语言验收（2026-10-02）

实际环境：Node 24.21.0、MySQL 8.0.45、Prisma 6.19.0、NestJS 11.2.6、React 19、Vite 7.3.6、TypeScript 5.9.3，以锁文件为准。保留 MySQL、Decimal 和已有用户隔离规则；归档项目仍参与总额。Revision.amount 是变更后的余额。

## 查询与计算

- `/positions?kind=account|asset|debt` 只带当前余额、必要资料、可见关联及本位币折算；`/positions/:id` 返回必要资料与当前原币余额。两者不带历史。
- `/overview` 只带当前总资产、负债、净资产、必要明细及汇率状态。
- `/history`、`/positions/:id/history`、`/transfers` 支持 `limit`、`cursor`、`from`、`to`；历史另支持 `positionId`。默认 50，最多 100，最近流水使用同一接口 limit=20。返回 `{items,nextCursor,revealed}`。历史按 effectiveDate DESC、唯一 sequence DESC；往来按 effectiveDate DESC、唯一 id DESC。
- 历史先从每个可见项目的复合索引取至多 limit+1 条，再合并页；只对入选记录定位真实前序余额，分页首条的 before 不假定为零。项目非常多时，查询数仍随项目数增长。
- 最新余额使用按项目分支的参数化 UNION ALL，每个分支按 `[positionId,effectiveDate,sequence]` 反向索引扫描 LIMIT 1；最多 100 个分支一批。没有反规范化当前余额字段，因此无需余额回填或缓存重建，历史补录、更正、导入恢复后直接从历史重算。
- 已捕获 Prisma 实际 SQL：单父项目 nested take:1 有数据库 LIMIT；多父项目 nested take:1 产生无 LIMIT 的 revisions 查询，由客户端裁剪。不能仅靠 take 判断查询代价。本次使用明确的数据库分支限制。
- 更正只查目标及相关配对约束。不能改配对记录或在其之前插入/更正；同业务时间使用 sequence 比较，配对后同分钟的普通余额记录可以更正。保留业务约束，避免破坏双方账。
- `/trend` 默认最近 90 天。day 最多 366 天、week 最多 1096 天、month 最多 3653 天。使用区间前最后余额和汇率作种子，数据库取范围内每日最后余额；应用排序一次并顺序推进。响应不带每日期完整项目明细。
- 周以周一至周日、月以自然月取期末余额；变化归因累加该段每日余额变化与汇率变化，首尾不完整周期按实际范围。缺失汇率标记不完整，沿用时保留实际 rateDate。仅查询相关币种、本位币的区间汇率和必要前序汇率；当前总额只查询最新可用汇率。

## 实测证据

随机独立测试用户，原服务 3100 与优化后隔离服务 33101 使用同一数据库；每项 3 次取中位数，全部为实际 HTTP 测量，响应大小为未压缩 JSON 字节。测试记录集中在 90 天内，金额虚构，测试结束清理该测试用户。完整 SQL、EXPLAIN ANALYZE、处理函数计时及 HTTP 结果见 [原始证据](../evidence/performance-final.json)。原始证据中的 HTTP queries=0 表示远端 HTTP 客户端未采集 SQL 事件，不代表数据库零查询。

| 数据           |  账户列表：前 → 后 |    列表响应：前 → 后 |   当前总览：前 → 后 | 历史 50 条 | 日趋势 90 天 |
| -------------- | -----------------: | -------------------: | ------------------: | ---------: | -----------: |
| 单账户 1 万    |  288.13 → 11.59 ms |    6,097,025 → 368 B |    992.35 → 7.36 ms |   19.20 ms |     54.64 ms |
| 单账户 10 万   | 2,826.90 → 5.56 ms |   61,267,028 → 370 B |  9,885.51 → 5.39 ms |   38.50 ms |    585.14 ms |
| 10 账户各 1 万 | 2,869.42 → 6.19 ms | 60,970,241 → 3,671 B | 15,636.96 → 5.48 ms |   34.32 ms |    568.12 ms |

单账户 10 万条 EXPLAIN ANALYZE：最新余额索引节点实际 rows=1 loops=1；历史候选索引节点 rows=51 loops=1；每条前序余额子查询实际 rows=1。多账户每分支分别限量。资金往来最终采用 FORCE INDEX + STRAIGHT_JOIN，以用户/时间/id 为驱动；60 条同时间测试记录，首批索引实际 rows=51，游标下一页 rows=10，无全量排序，见 [往来分页计划](../evidence/transfers-plan.json)。隐藏或指定账户过滤需要跳过不匹配行，实际扫描可多于返回条数。旧列表实际返回全部 1 万/10 万历史，旧总览也读取全部历史；没有采集旧查询精确存储引擎 rows_examined，因此不将返回行数冒充扫描统计。新增全局日期索引曾导致优化器选择全局历史路径，已通过第二迁移移除，最终使用项目复合索引。EXPLAIN 中 cost/estimated rows 与 actual rows 含义不同。

前端请求日志及浏览器实测：总览为 overview、trend、history(limit20) 共 3 个财务 GET；账户列表 1 个；详情 2 个；加载下一页只 1 个 history；变化记录页 2 个；打开资金往来表单才取账户/债务选项。旧统一加载为 positions、overview、transfers、settings 共 4 个 GET，各页面都请求全部历史。总览现在虽为 3 个 GET，但每个职责有界；账户列表从 4 降到 1。语言切换为 0 个财务 GET。认证 me 和交互活动另计；启动 me 通过共享 Promise 避免开发 StrictMode 重复。日期范围改变只请求 trend；过期响应由会话、加载序号和当前选择校验拦截。

这些是本机对当前数据库的结果，不是生产并发/p95 保证。区间内 10 万条趋势仍需数据库窗口排序，约 0.6 秒；未引入每日快照、缓存或新基础设施。游标页在并发历史更正后应重新加载，未提供跨请求冻结快照。

## 借入、借出及手续费

债务 side=liability 表示借入/应付，side=asset 表示借出/应收。资金往来复用 `/transfers`，operation 为 transfer、borrow、lend、collect、repay。来源为启用中的资产账户，目标为另一资产账户或对应方向的债务。同币种账户本金与债务本金相等，跨币种填写实际金额。

借入到账：账户 +(amount-fee)，应付 +received；借出：账户 -(amount+fee)，应收 +received；收回应收：账户 +(amount-fee)，应收 -received；偿还应付：账户 -(amount+fee)，应付 -received。手续费可为负数表示优惠，绝对优惠不超过本金；收款正手续费不超过本金；禁止负余额或超额还款。金额仍为 Decimal。

双方行按 ID 顺序加锁，最新余额读取、幂等校验、双边历史、往来记录及自动关联同处 Serializable 事务。死锁/写冲突有限重试（最多 3 次重试）。账户详情预选当前账户；债务详情按关联预选账户。借入/借出操作、流水、详情互相可导航。新建债务可先录已有余额；新发生借贷建议建 0 余额后使用联动操作，避免重复计入。

ZIP v6 增加 operation；保留 v3/v4/v5 ZIP、v1/v2 JSON 读取。恢复校验双边前后余额、操作方向、费用和配对原因，不改变历史金额含义。

## 三种语言

顶部及登录页支持简中、English、繁中，语言保存在本浏览器 localStorage。静态词典覆盖页面、表单、图标交互和常见服务端错误；用户名称、备注、原币金额保持原文。繁中由开发时 OpenCC 生成静态 JSON，不在浏览器运行转换。修改英文词典后执行 `node apps/web/scripts/generate-locales.cjs`；安全清空确认短语仍精确要求“确定清空”。

## 迁移、部署与复验

本次已对配置数据库执行 migrate deploy，四个迁移：

1. `20261002000000_query_indexes`：Revision 项目/日期/顺序及配对约束索引、Transfer 用户/日期/id 索引。
2. `20261002000100_remove_global_revision_index`：移除实测不合适的全局日期索引。
3. `20261002000200_debt_movements`：Transfer.operation 默认 transfer，旧记录自动获得原转账语义。
4. `20261002000300_chinese_comments`：8 张业务表及 73 个字段增加中文注释，Prisma 模型同步文档注释。迁移保留 SHOW CREATE TABLE 原列定义，不改变字段类型、默认值和自增；数据库元数据验证见 [注释核验](../evidence/database-comments.json)。Prisma 自身的迁移元数据表不作为业务表修改。

无余额列回填；未删除真实历史。其他环境需先备份，停止 API 释放 Windows Prisma DLL，再按下面步骤部署同步后端与前端：

```powershell
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm db:status
pnpm typecheck
pnpm build
pnpm test
# 启动优化后的 API 后
$env:TEST_API_URL='http://127.0.0.1:3100/api'
pnpm test:integration
```

最终验证：类型检查和生产构建通过；18 个单元测试、8 个真实 MySQL 集成测试通过。涵盖历史补录/更正、同时间顺序、前序余额/分页、归档、隐藏解锁/用户隔离、缺失汇率/本位币切换、负手续费、并发幂等转账与收款、借入借出/还款、ZIP 完整恢复。浏览器验证了 50+10 条分页、详情转账预选、债务关联导航、还款表单默认账户及中英繁切换/刷新持久化。

基准可重跑：在 apps/api 执行 `pnpm exec tsx scripts/performance.ts rerun`；TEST_API_URL 指向优化后服务，BASELINE_API_URL 可选指向独立旧版本服务，结果输出 docs/evidence/performance-rerun.json。脚本只生成/清理随机测试用户。连续反复认证集成测试可能触发现有每 IP 15 分钟 30 次认证限速；本次通过重启隔离测试进程复验，生产限制未放宽。
