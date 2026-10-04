ALTER TABLE `AgentGrant` MODIFY `refreshExpiresAt` DATETIME(3) NULL COMMENT '刷新授权到期时间，UTC；空表示永久 OAuth 授权或个人令牌不适用';
