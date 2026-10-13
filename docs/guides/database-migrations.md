# 数据库迁移

在仓库根目录执行：

```sh
pnpm db:migrate
```

Docker 部署需要重新构建镜像以包含修复后的迁移脚本，再执行迁移：

```sh
docker compose build app
docker compose run --rm app node scripts/database.cjs deploy
docker compose up -d app
```

请使用以上项目入口。历史目录 `005_account_icons`、`006_navigation_transfers`、`007_notes_display` 排在 `202610010001_initial` 前面，直接运行 Prisma `migrate deploy` 会在空库首先创建 Icon，因 User 表尚不存在而出现 MySQL 1824。项目入口先通过 Prisma 部署四个初始迁移，再部署完整迁移集合。历史 SQL 与目录名称保持原样，已有数据库的记录和校验值不变；重复运行只应用尚未执行的迁移。

如果已经遇到该失败，更新代码或镜像后重新运行项目入口即可。脚本仅在确认没有业务表、没有成功迁移、仅有 `005_account_icons` 的 1824 失败且执行步数为零时，通过 Prisma `migrate resolve --rolled-back 005_account_icons` 标记该次失败，再按正确顺序迁移。不会执行 reset、db push 或删除业务表。

其他失败、部分执行或没有迁移记录的已有表会拒绝自动恢复，需要根据实际数据库状态手动处理。不要直接把失败记录标记为 applied，也不要对有数据的库执行 reset。Prisma 官方说明见 [生产迁移故障恢复](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/patching-and-hotfixing)。

隔离回归入口：

```sh
pnpm --filter @worthpath/api test:isolated
```

测试只创建和清理随机 `wp_test_` 库，覆盖真实空库初始化、重现 005 失败并恢复、迁移校验值一致、重复执行保留数据和历史、拒绝未跟踪的已有表，以及完整业务回归。

## 更换本地数据库

修改 apps/api/.env 的 DATABASE_URL 后，从 apps/api 执行 node scripts/db-preflight.cjs，再从项目根执行 pnpm db:migrate。空库会按依赖顺序迁移。随后运行 pnpm --filter @worthpath/api build 和 pnpm --filter @worthpath/api icons:seed；迁移状态用 pnpm db:status 检查，表/字段注释在 apps/api 执行 node scripts/check-comments.cjs 核验，输出位于 docs/evidence/database-comments.json。不要提交真实环境配置。

2026-10-13：新的本地测试库已应用 29 个迁移，17 张表和 163 个字段的注释全部通过核验，并初始化 36 个内置图标。
