```shell
# 首次登录，建议使用有包写入权限的访问令牌
docker login git.chyuovo.top
# 版本号
# docker build -t git.chyuovo.top/chyuovo/worthpath:v1.0.1 .
# docker push git.chyuovo.top/chyuovo/worthpath:v1.0.1
# 只推送最新
docker build -t git.chyuovo.top/chyuovo/worthpath:latest .
docker push git.chyuovo.top/chyuovo/worthpath:latest
```

