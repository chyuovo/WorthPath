ALTER TABLE `AgentGrant` MODIFY `expiresAt` DATETIME(3) NULL COMMENT '访问令牌到期时间，UTC；空表示可撤销的永久个人令牌';
