-- Metadata only. Preserve existing policy rows; the application no longer reads them.
ALTER TABLE `AgentPolicy` COMMENT = '已停用的历史 Agent 策略数据，保留原数据但不参与权限判定';
ALTER TABLE `AgentGrant` MODIFY `scopes` JSON NOT NULL COMMENT '权限列表：read、draft 或 write；隐藏账户附加权限 hidden_read、hidden_write';
