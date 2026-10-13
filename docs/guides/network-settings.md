# 网络访问配置

API 和网页开发服务共同读取 [环境配置模板](../../apps/api/.env.example)，模板中每个变量都有中文说明。真实配置位于 apps/api/.env，已被 Git 忽略，不提交数据库连接或密码。

当前配置允许所有本机 IPv4 网卡、任意请求 Host 和有效的 HTTP/HTTPS 浏览器来源，并允许 HTTP MCP 服务及 HTTP 客户端回调。OAuth 的资源地址和网页授权地址仍使用配置的固定地址；远程客户端需要能访问该地址。登录、令牌、用户隔离及权限检查继续生效。

| 配置范围 | 变量 |
| --- | --- |
| API 监听与主机 | API_HOST、PORT、API_ALLOWED_HOSTS |
| 网页开发服务 | WEB_HOST、WEB_PORT、WEB_ALLOWED_HOSTS、WEB_API_PROXY |
| 网站来源 | WEB_ORIGIN、NETWORK_ALLOW_WILDCARD_ORIGINS |
| MCP 地址与来源 | MCP_PUBLIC_URL、MCP_WEB_URL、MCP_ALLOWED_HOSTS、MCP_ALLOWED_ORIGINS、MCP_ALLOW_LOOPBACK_HOSTS |
| HTTP 和回调 | NETWORK_ALLOW_HTTP、NETWORK_ALLOW_HTTP_REDIRECTS |
| Cookie | COOKIE_SECURE、COOKIE_SAME_SITE、NETWORK_REQUIRE_SECURE_COOKIE |
| HTTPS 响应策略 | NETWORK_HSTS、NETWORK_UPGRADE_INSECURE_REQUESTS |
| 请求限流 | NETWORK_RATE_LIMIT_ENABLED、NETWORK_RATE_LIMIT_WINDOW_MS、NETWORK_AUTH_RATE_LIMIT_MAX、MCP_AUTH_RATE_LIMIT_MAX |

## 上线调整

将 NODE_ENV 改为 production，按实际域名设置 Host/Origin 白名单和 HTTPS 固定地址；关闭 HTTP、非本机 HTTP 回调及来源通配符，启用 Secure Cookie、HSTS、HTTPS 子资源升级。完整配置说明在环境模板中。显式环境开关优先于 NODE_ENV，修改环境名不会覆盖已设置的开放开关。

HTTP 使用 COOKIE_SECURE=false；COOKIE_SAME_SITE=none 必须使用 Secure Cookie。同站网页经 /api 代理访问保持 strict 即可。API 和网页开发服务都需重启才能读取新值，生产静态页面的访问端口由反向代理或部署服务配置。公网能否连接仍取决于路由、反向代理和防火墙；本次未修改这些系统设置。

## 验证

生产构建通过，43 项单元测试与 6 项真实 HTTP OAuth/MCP 测试通过。当前 HTTP 服务的 OAuth 发现返回 200，任意测试 Host/Origin 的 API 和 MCP 预检均返回 204。测试使用独立服务与临时账号，未修改真实用户账目。
