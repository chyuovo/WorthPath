# MCP 接入排查与提示统一

2026-10-04 02:23（UTC+8）。使用临时账号验证，真实用户账目、令牌及 Codex 配置未修改。

## 发现

本机已有 enabled 的 worthpath Streamable HTTP 配置，URL 为 http://localhost:3100/mcp。该配置未指定 Bearer 环境变量或 Authorization 头；CLI auth_status=unknown，不能以该状态断言 OAuth 凭据存在或不存在。本次会话没有加载 WorthPath 工具。服务 OAuth 资源发现返回正常元数据，未认证 MCP 请求返回 401。

教程贴入聊天不会注册 MCP 服务。客户端必须先完成配置、认证和工具加载。localhost 只指请求执行端所在电脑，远端客户端需要可达 HTTPS 服务，不能根据网页预览声称已连接。

## 修改

- apps/web/src/AgentConnections.tsx：教程前置连接检查、网络边界、Bearer 配置限制；折叠显示已验证 Codex OAuth 命令；成功和错误反馈统一右上角 Toast。
- apps/web/src/Toast.tsx：提取 showToast，重复复制相同命令也刷新通知，复用已有自动消失、去重、关闭和模态框兼容机制。
- apps/web/src/App.tsx：汇率更新失败使用相同 Toast；汇率状态仍作为可查询信息显示。缺少汇率造成总额不完整等持续业务说明保留。
- docs/mcp/mcp.md：实际接入步骤、已验证客户端范围、环境变量 PAT 的进程继承限制。
- update.md：完成提示统一要求并记录接入修正。

## 实际验证

- Codex CLI 0.160.0，独立临时 CODEX_HOME，OAuth/DCR + S256 PKCE；临时用户 read 授权成功，CLI 回调与凭据保存成功。
- 使用 CLI 发行的 OAuth 凭据通过官方 SDK 1.31.0 初始化、发现 39 个工具、调用 connection_info；权限 read，隐藏读写均 false。
- 临时用户、DCR 注册、授权和临时客户端凭据已清理，没有使用聊天中暴露的个人令牌。
- 前端 TypeScript 检查及生产构建通过。
- 浏览器验证新说明和命令、复制后右上角成功提示、重复复制刷新、错误密码请求拒绝且右上角错误提示。令牌值不出现在 Toast 中。

本次没有数据库模型或业务服务变更，无新增迁移。没有重复运行此前 REST/MySQL 全业务回归；此前结果见更新记录。本次尚未验证 Codex 桌面会话直接工具调用、其他商业客户端或公网 HTTPS 部署。CLI 登录测试与 SDK 工具调用测试不等于这些验证。

具体接入步骤见 [MCP 文档](mcp.md)。没有部署或推送。

## 页面配置提示词（2026-10-04 02:32 UTC+8）

新增复制 Codex 配置提示词入口与只读、草稿、普通写入三档申请权限，默认 read,draft。提示词授权本机 Codex 执行连接配置和 OAuth 登录，仅修改 worthpath 连接并保留其他配置；网页确认由用户完成，配置阶段不修改账目。浏览器实际验证三种选项的剪贴板内容、正确资源地址与 scopes；前端类型检查和构建通过，临时账号已清理。没有启动新的真实用户 OAuth 授权，也没有验证外部 Codex 自动执行整段提示词；底层 CLI OAuth 路径沿用本页已有实际验证。

## OAuth 请求范围收窄（2026-10-04 02:56 UTC+8）

授权页新增候选/最终权限的明确区分与动态预览，并优化隐藏权限复选框。配置提示词说明默认 CLI 请求全部权限不等于全部授权，显式 read,draft 路径实测只请求两项，最终始终由用户网页选择与服务端限制。

新增可选 test:mcp:codex，两项真实 Codex CLI 0.160.0 OAuth/DCR 测试通过：显式 read,draft 和默认全部五项请求，网页同等的 consent 选择均发行仅 read,draft 的令牌；39 工具发现、连接权限验证、草稿 pending 且没有直接入账通过。浏览器确认只读默认、草稿选择后最终显示 read,draft、隐藏权限关闭，没有在浏览器点击授权。测试账号与注册已清理。前后端类型检查和前端构建通过，未重复全业务回归，无新增迁移。
