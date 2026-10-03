ALTER TABLE `_prisma_migrations`
  COMMENT = 'Prisma 数据库迁移执行记录，由迁移引擎管理',
  MODIFY `id` VARCHAR(36) NOT NULL COMMENT '迁移执行唯一标识',
  MODIFY `checksum` VARCHAR(64) NOT NULL COMMENT '迁移文件 SHA-256 校验摘要',
  MODIFY `finished_at` DATETIME(3) NULL COMMENT '迁移成功完成时间',
  MODIFY `migration_name` VARCHAR(255) NOT NULL COMMENT '迁移目录名称',
  MODIFY `logs` TEXT NULL COMMENT '迁移引擎错误和诊断信息',
  MODIFY `rolled_back_at` DATETIME(3) NULL COMMENT '迁移标记回滚时间',
  MODIFY `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '迁移开始时间',
  MODIFY `applied_steps_count` INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已执行步骤数量';
