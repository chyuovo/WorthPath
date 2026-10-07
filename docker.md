# WorthPath Docker 部署

```
# 打包
docker build -t worthpath:local .
docker save -o E:\worthpath-local.tar worthpath:local
```

```shell
# 添加固定网桥
docker network create \
  --driver bridge \
  --subnet 172.30.50.0/24 \
  --gateway 172.30.50.1 \
  --opt com.docker.network.bridge.name=br-worthpath \
  worthpath

# MySQL 允许172.30.50.0/255.255.255.0 连接

# 更新防火墙
ip -4 addr show br-worthpath


sudo ufw allow in on br-worthpath \
  from 172.30.50.0/24 \
  to 172.17.0.1 port 3306 proto tcp \
  comment 'WorthPath MySQL'

# 创建图标持久化目录，容器内 node 用户的 UID/GID 为 1000
sudo install -d -m 750 -o 1000 -g 1000 /opt/worthpath/data/icons

# 执行数据库迁移
docker compose run --rm app node scripts/database.cjs deploy

# 初始化内置图标
docker compose run --rm app node scripts/seed-icons.cjs

# 启动应用
docker compose up -d --no-build app
docker compose ps
docker compose logs --tail=100 app

# 更新
# 保留旧镜像，方便回退
docker tag worthpath:local worthpath:rollback

# 加载新镜像并重新创建应用容器
docker load -i worthpath-local.tar
docker compose up -d --no-build --force-recreate app

# 查看运行状态和日志
docker compose ps
docker compose logs --since=2m --tail=100 app
```

## 更新已部署的项目（尚未上传图片）

图标持久化新增配置不需要数据库结构迁移，也不需要搬运上传图片。保留服务器已有 `.env.production`、MySQL 与反向代理配置；更新镜像和 Compose 的图标挂载即可。历史空库迁移修复也包含在此次更新中，已完成迁移的数据库不用重复初始化或运行图标 seed。

本机重新打包镜像并导出（在源码项目目录执行）：

```powershell
docker build -t worthpath:local .
docker save -o E:\worthpath-local.tar worthpath:local
```

将新的 `worthpath-local.tar` 和 `compose.yaml` 传到服务器 `/opt/worthpath`，同步 Compose 时保留服务器已有的环境文件路径、端口和数据库网络配置。若希望只修改现有 Compose，在 `services.app` 下合并以下配置（不要重复创建已有的 `environment` 或 `volumes` 键）：

```yaml
environment:
  ICON_STORAGE_DIR: /app/data/icons
volumes:
  - type: bind
    source: /opt/worthpath/data/icons
    target: /app/data/icons
    bind:
      create_host_path: false
```

服务器执行：

```bash
cd /opt/worthpath
sudo install -d -m 750 -o 1000 -g 1000 /opt/worthpath/data/icons
docker load -i worthpath-local.tar
docker compose up -d --no-build --force-recreate app
docker compose ps
docker compose logs --tail=100 app
```

上述使用 `worthpath:local`，服务器 Compose 的 `image` 标签需要一致。Compose 已设置容器路径，已有 `.env.production` 无需额外添加变量。启动时现有内置图标也会自动落盘，因此尚未上传图片时目录也可能已有 PNG。随后在网页上传一张图标，可在服务器执行 `find /opt/worthpath/data/icons -maxdepth 1 -type f -name '*.png'` 检查文件。

## 部署结构

前后端合并为一个应用容器：构建时编译 React/Vite 和 NestJS，将网页产物复制到 `apps/api/public`；运行时只启动 `node dist/main.js`。同一端口提供网页、`/api`、MCP 和 OAuth，不启动 Vite 开发服务。

```text
浏览器 / MCP 客户端
        ↓ HTTPS
服务器 Caddy / Nginx
        ↓ http://127.0.0.1:3100
WorthPath 应用容器
        ↓
已有 MySQL 数据库
```

本仓库的 `compose.yaml` 只管理应用，不创建数据库。需要已有 MySQL 8+、已创建的 `worthpath` 数据库及可用的数据库账号。Compose 使用命名镜像，可通过 `WORTHPATH_IMAGE_TAG` 区分版本。运行镜像保留 Prisma CLI 和相关依赖，以便单独执行迁移，不包含后端源码、测试或前端开发目录。

上传图标持久化到宿主机 `/opt/worthpath/data/icons`，Compose 将它绑定到容器 `/app/data/icons`，并设置 `ICON_STORAGE_DIR=/app/data/icons`。使用 SHA-256 作为 PNG 文件名，相同内容去重。上传及 ZIP 恢复时写入文件；应用启动时分批补齐数据库中的已有图标。数据库继续保留图片内容，支持现有自包含 ZIP 备份，并可自动修复缺失或损坏的图标文件。图标访问仍通过带身份与可见性校验的 `/api/icons/:id/image` 接口；不要将该目录作为 Nginx 静态目录公开。

首次启动前创建目录并设置权限（见上面的 `install` 命令）；已有目录权限不正确时执行 `sudo chown 1000:1000 /opt/worthpath/data/icons`。Compose 不自动创建宿主机目录，以避免生成 root 所有且不可写的目录。换镜像或重建容器会保留这些文件。图标文件按内容共享，删除账号或清空数据会撤销数据库引用和接口访问，不自动删除磁盘上的内容文件；服务器备份应包含该目录与 MySQL。

## Windows 本机安装 Docker 与构建镜像

本机开发/构建使用 Docker Desktop 的 WSL 2 后端，服务器运行使用 Docker Engine。你可以选择直接在 Linux 服务器构建，本机安装 Docker 不是服务器部署的前置条件。

先打开任务管理器 → 性能 → CPU，确认“虚拟化”已启用。如果未启用，需要在 BIOS/UEFI 打开硬件虚拟化。

以管理员身份打开 PowerShell，安装 WSL（不额外安装 Ubuntu）：

```powershell
wsl --install --no-distribution
```

按提示重启电脑，然后执行：

```powershell
wsl --update
wsl --version
```

Docker Desktop 要求 WSL 2.1.5 或更新版本。参考 [Microsoft WSL 命令说明](https://learn.microsoft.com/en-us/windows/wsl/basic-commands) 和 [Docker Desktop Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)。

从上述 Docker 官方页面下载符合电脑架构的安装包（x64 电脑选择 x86_64），运行安装程序并选择 WSL 2 后端。安装完成后打开 Docker Desktop，完成其首次启动步骤，等待引擎启动，使用 Linux containers。

重新打开 PowerShell，验证客户端、引擎和 Compose：

```powershell
docker version
docker compose version
docker info --format '{{.OSType}}'
docker run --rm hello-world
```

`docker version` 应同时显示 Client 和 Server，操作系统类型应为 `linux`，hello-world 应正常输出成功说明。只有客户端信息或“无法连接引擎”时，先检查 Docker Desktop 是否已启动。不要在 Windows containers 模式构建本项目。

然后在项目目录只构建镜像，不需要数据库配置，也不会执行数据库迁移：

```powershell
cd E:\WorthPath
docker build -t worthpath:local .
```

如果 Docker 能运行但构建下载失败，检查错误对应的镜像仓库/npm/Debian 源网络和 Docker Desktop 代理配置，避免修改业务数据库配置来解决下载问题。

本机与服务器架构不同时，例如本机 x64、服务器 ARM64，需要按服务器架构构建镜像；上述默认命令按当前 Docker 引擎架构构建。服务器直接构建可以减少架构不匹配的问题。

## 当前验证记录

2026-10-05：已通过前后端 TypeScript 检查、前后端生产构建，以及网页托管/网络/Host 的 6 项回归测试。检查了真实环境文件的 Git 忽略规则。测试不连接业务数据库。

初次验证时本机未找到 Docker 命令。随后配置正式部署环境时，已检测到 Docker CLI，并通过配置解析检查。图标持久化修改通过 57 项单元测试和 30 项隔离业务回归，包含真实上传落盘、备份恢复落盘、缺失或损坏文件修复及权限隔离。Compose 使用 `docker compose config --no-env-resolution --quiet` 校验结构，未读取服务器上的环境文件。服务器目录权限、容器内迁移与真实 HTTPS/MCP 联通仍需在部署环境验证。

本机 Docker Desktop 的 Linux 引擎已完成修改后镜像构建，包含前后端生产构建。两个断网临时容器验证了 UID 1000 写入绑定的测试目录，以及第一个容器销毁后第二个容器读取同一 PNG。测试目录已清理，未连接业务数据库；此验证不代表服务器 `/opt/worthpath/data/icons` 的权限已配置。

## 1. 准备服务器

建议使用 Linux 服务器，安装 Docker Engine 和 Docker Compose 插件，准备可用域名及 HTTPS 反向代理。以下部署命令在服务器的项目根目录执行，使用 Linux shell。

```bash
docker --version
docker compose version
```

服务器构建镜像需要访问镜像仓库、npm 包仓库和 Debian 软件源。镜像中固定 pnpm 11.19.0，并使用锁文件安装依赖；Node 基础镜像为 `node:24-bookworm-slim`，需要严格复现时另行固定镜像 digest。

## 2. 配置生产环境

针对本次正式部署：网站为 `https://worthpath.chyuovo.top`，MySQL 和 Nginx 均在宿主机，应用在容器内。根目录 `.env.production` 已按此拓扑填写并添加中文注释，数据库和初始管理员密码仍为占位符，必须自行替换。

应用容器通过 `host.docker.internal:3306` 访问数据库，Compose 已加入 `host-gateway` 映射。映射不能绕过 MySQL 的监听限制：若 MySQL 只绑定宿主机 `127.0.0.1`，需另外允许 Docker 可达的宿主机私有接口，限制数据库账号来源和防火墙，不开放公网 3306。MySQL 8.0.13+ 支持配置多个具体监听地址；填写前需确认服务器版本和实际接口地址。

宿主机 Nginx 上游使用 `http://127.0.0.1:3100`，并保留外部 Host。当前 Compose 的端口只绑定宿主机回环地址，无需共享 Docker 网络，不应改成公网发布 3100。

上述数据库监听与 Nginx HTTPS 代理配置尚未在服务器执行或验证；仅写环境文件不会使这些服务器前置条件自动完成。

首次部署复制模板；已有配置时不要再次覆盖：

```bash
cp -n .env.production.example .env.production
chmod 600 .env.production
```

编辑根目录 `.env.production`，至少替换：

| 配置                                     | 填写内容                            |
| ---------------------------------------- | ----------------------------------- |
| `DATABASE_URL`                           | 服务器实际可访问的 MySQL 连接地址   |
| `ADMIN_PASSWORD`                         | 首次初始化管理员使用的强密码        |
| `API_ALLOWED_HOSTS`、`MCP_ALLOWED_HOSTS` | 真实域名；非默认端口需要包含端口    |
| `WEB_ORIGIN`、`MCP_ALLOWED_ORIGINS`      | 网站完整 HTTPS 来源，通常无结尾斜杠 |
| `MCP_PUBLIC_URL`                         | `https://你的域名/mcp`              |
| `MCP_WEB_URL`                            | `https://你的域名`                  |

模板的生产安全开关已经关闭 HTTP 和通配来源，并开启 Secure Cookie。不要直接沿用 `apps/api/.env` 的开放开发配置。根目录 `.env.production` 由 Compose 注入容器，镜像不携带真实 `.env`；本地 `apps/api/.env` 不会被修改。

数据库密码中的特殊字符需 URL 编码。容器的 `localhost` 指容器自身，不能用它连接宿主机 MySQL：

- 独立数据库服务器：填写实际可达地址，允许应用服务器访问。
- 同一 Docker 网络的 MySQL：填写数据库服务名，例如 `db`，并将应用加入该网络。
- Linux 宿主机 MySQL：可在 Compose 的 `app` 下加 `extra_hosts: ["host.docker.internal:host-gateway"]`，连接地址填 `host.docker.internal`。MySQL 必须监听容器可达的接口，并为容器来源配置账号授权与防火墙；仅监听 `127.0.0.1` 无法连接。

数据库不必暴露到公网。使用专用账号；迁移账号需要 DDL 权限，长期运行账号可在迁移后改为较小权限。应用不会自动创建数据库。

## 3. 配置 HTTPS

默认发布端口为 `127.0.0.1:3100:3100`，供服务器上的反向代理访问，不对外直接开放 3100。

服务器上安装 Caddy 后，Caddyfile 可使用：

```caddyfile
worthpath.example.com {
    reverse_proxy 127.0.0.1:3100
}
```

域名解析到服务器，允许访问 80/443。将示例域名替换成环境文件中的同一个域名，再按服务器已有方式验证并加载 Caddy 配置。

如果已有 Nginx，核心代理配置如下；证书和 HTTPS server 配置由你的服务器提供：

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 300s;
    client_max_body_size 512m;
}
```

所有路径都代理到应用，包括 `/api`、`/mcp`、OAuth 端点和 `/.well-known/*`。不要只代理 `/api`。代理需支持大文件上传（应用备份最大 512 MB），并保留请求 Host。

如果反向代理也在 Docker 中，`127.0.0.1` 是代理容器自身。需让两者加入同一 Docker 网络，将上游改为 `app:3100`，并确认仍保留外部 Host。此时可以移除宿主机端口发布。

当前应用的登录限流存储在进程内，且未配置受信反向代理 IP 解析。代理后的多个用户可能共用限流来源；增加副本不会共享限流计数。较多用户或多副本部署前，需要完善代理信任和共享限流策略。

## 4. 构建、迁移、启动

下面命令会修改所配置的数据库。已有数据先备份，并确认 `DATABASE_URL` 指向正确数据库。

```bash
# 编译前后端，生成 Linux Prisma 客户端；不连接数据库或执行迁移
docker compose build app

# 使用一次性容器执行 Prisma migrate deploy；失败后不要继续启动
docker compose run --rm app node scripts/database.cjs deploy

# 初始化/更新固定 ID 的内置图标；保留用户财务数据和上传图标
docker compose run --rm app node scripts/seed-icons.cjs

# 启动唯一的应用服务
docker compose up -d app

docker compose ps
docker compose logs --tail=100 app
```

上述一次性容器与应用使用相同镜像和环境文件。迁移或图标初始化失败时先解决错误；没有自动迁移、重置数据库或启动时自动改密。初始管理员只在数据库没有管理员时创建；首次网页登录后必须改密。部署到新数据库不会带上本机数据。

## 5. 验证

按顺序检查：

1. 容器保持运行，日志显示 `WorthPath API ready`，没有循环重启。
2. HTTPS 网站打开正常，浏览器网络面板中的 `/assets/*` JS/CSS 返回 200；刷新页面仍能打开。
3. 登录、账户查询正常，登录 Cookie 带 Secure；无需启动 5173 端口的开发服务。
4. `/agent/authorize` 和 `/agent/operation` 加上实际授权参数后，显示正确的授权或草稿确认页。
5. 使用助手页面生成的新 HTTPS MCP 地址重新接入，验证 OAuth 发现、授权和只读查询。旧本机地址不会自动更新。
6. `/api/不存在的路径` 与 `/assets/不存在的文件.js` 不应返回前端 HTML；未授权的服务请求应保持后端错误响应。
7. 重启容器后仍可查询原数据；数据保存在 MySQL，应用容器可以替换。

首页连通性可通过域名检查，也可在服务器本机带正确 Host 检查：

```bash
curl -I https://worthpath.example.com/
curl -I -H 'Host: worthpath.example.com' http://127.0.0.1:3100/
```

本机 HTTP 检查只能确认页面服务连通；生产登录和 Secure Cookie 需要通过 HTTPS 验证。

## 6. 更新与回退

建议为每次发布使用唯一版本标签，例如：

```bash
export WORTHPATH_IMAGE_TAG=20261005-1
docker compose build app
```

更新顺序：备份数据库 → 保存旧版本标签/镜像 → 更新源码 → 构建新镜像 → 执行迁移 → 按需运行图标初始化 → 替换应用 → 完成上述验证。

```bash
docker compose run --rm app node scripts/database.cjs deploy
docker compose up -d --no-deps app
docker compose logs --tail=100 app
```

回退应用时切换到保留的旧镜像标签，使用 `docker compose up -d --no-build app`。应用镜像回退不会回退数据库迁移；必须确认旧代码兼容新 schema，否则需按已验证的数据库恢复方案处理。

停止应用：

```bash
docker compose stop app
```

数据库单独备份到服务器之外，并验证恢复。应用镜像、容器和数据卷均不替代数据库备份；数据库账号、登录授权等完整迁移应采用数据库级迁移方案。个人业务备份导出/恢复仍由用户在网站操作。

## 7. 本地开发与排查

原有 `pnpm dev` 保持前后端分开开发；没有 `apps/api/public/index.html` 时，API 不启用网页托管。本地验证合并网页可以先 `pnpm build`，再将 `apps/web/dist` 复制为 `apps/api/public`，此目录已加入 Git/Docker 忽略规则。清理该目录后恢复纯 API 开发入口。

- 页面 403：检查代理保留的 Host 与 `API_ALLOWED_HOSTS` 是否一致。
- MCP Host/Origin 错误：检查固定 HTTPS 地址和白名单，而不是改成 `*`。
- 登录 Cookie 未发送：检查使用 HTTPS、`COOKIE_SECURE`、网页来源及浏览器 Cookie 状态。
- 数据库连接失败：检查容器可达地址、监听接口、账号来源授权与密码编码，不要打印真实连接字符串。
- 缺少表：确认迁移成功，不要使用 reset 处理生产数据。
- JS/CSS 404：检查镜像构建完成；如果新增 Vite 的其他顶层静态文件目录，需要同步扩展 `apps/api/src/web.ts` 的托管路径。

运行镜像包含 Prisma/迁移所需依赖，优先保证发布操作完整；后续可进一步拆分迁移镜像以减小应用镜像。日志设置了轮转，容器使用非 root 用户。镜像构建和服务器端完整验证必须在安装了 Docker 的环境执行。
