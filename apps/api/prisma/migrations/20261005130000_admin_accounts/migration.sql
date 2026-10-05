ALTER TABLE `User`
  ADD COLUMN `role` VARCHAR(16) NOT NULL DEFAULT 'user' COMMENT '系统权限：admin、user 或 readonly；管理员不能查看其他用户财务数据',
  ADD COLUMN `banned` BOOLEAN NOT NULL DEFAULT false COMMENT '封禁后禁止登录和使用已有会话、MCP 授权',
  ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false COMMENT '首次登录必须设置新的强密码';
