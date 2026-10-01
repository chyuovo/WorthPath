# WorthPath

个人资产负债与净资产管理。Node.js 22.12+、pnpm 11、MySQL 8+。

```powershell
pnpm install
Copy-Item apps/api/.env.example apps/api/.env
# 仅在本地 .env 设置 DATABASE_URL，先检查数据库是否存在
pnpm db:generate
pnpm db:migrate
pnpm dev
```

前端 http://localhost:5173，API http://localhost:3000/api。

```powershell
pnpm typecheck
pnpm build
pnpm test
```

设计见 docs/architecture.md。生产需要 HTTPS、COOKIE_SECURE=true、WEB_ORIGIN 为准确站点地址；前端构建由反向代理托管并代理 /api。不要公开开发服务器。
