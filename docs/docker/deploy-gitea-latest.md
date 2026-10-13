# Gitea latest 镜像发布与更新

完成时间：2026-10-08 13:28（UTC+8）。

Compose 固定使用 git.chyuovo.top/chyuovo/worthpath:latest，不再需要 WORTHPATH_VERSION。latest 是可覆盖的标签；本地推送新镜像后，服务器仍需要主动拉取并重建容器。

本地在项目根目录执行：

```powershell
docker login git.chyuovo.top
docker build -t git.chyuovo.top/chyuovo/worthpath:latest .
docker push git.chyuovo.top/chyuovo/worthpath:latest
```

服务器首次同步新的 compose.yaml，并确认 Gitea 容器仓库可用、已有镜像和所需拉取权限。现有环境文件、端口、数据库网络与图标挂载保持原配置。

服务器更新：

```bash
cd /opt/worthpath
docker login git.chyuovo.top
docker compose pull app
docker compose up -d --no-build app
docker compose ps
docker compose logs --tail=100 app
```

日常已登录后可以省略登录命令。仅重启容器不会拉取新镜像。若发布包含数据库迁移，先备份数据库，再于拉取后按既有流程执行 docker compose run --rm app node scripts/database.cjs deploy，成功后再替换应用。

需要保留回退镜像时，在拉取前给当前本地镜像加独立标签；不要将 latest 当作历史版本标识。本次仅修改配置和文档，未登录、构建、推送或部署，服务器连通性尚未验证。

参考：[Gitea Container Registry](https://docs.gitea.com/usage/packages/container/) 与 [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)。
