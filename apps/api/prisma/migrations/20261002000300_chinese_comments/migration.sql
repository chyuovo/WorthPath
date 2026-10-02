-- 仅增加中文注释；列定义来自现有 MySQL SHOW CREATE TABLE，保留类型、默认值、空值和自增属性。
ALTER TABLE `User`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `username` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录用户名，唯一',
  MODIFY COLUMN `passwordHash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '登录密码的 bcrypt 哈希，不存储明文',
  MODIFY COLUMN `baseCurrency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'CNY' COMMENT '本位币代码',
  MODIFY COLUMN `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间，UTC',
  MODIFY COLUMN `updatedAt` datetime(3) NOT NULL COMMENT '记录更新时间，UTC',
  MODIFY COLUMN `idleMinutes` int NOT NULL DEFAULT '30' COMMENT '无操作退出分钟数，0 表示关闭',
  MODIFY COLUMN `hiddenMenus` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '隐藏菜单标识列表',
  MODIFY COLUMN `showNotes` tinyint(1) NOT NULL DEFAULT '1' COMMENT '是否显示备注',
  COMMENT = '用户及个人设置';

ALTER TABLE `Session`
  MODIFY COLUMN `id` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '随机会话令牌的 SHA-256 摘要',
  MODIFY COLUMN `userId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所属用户标识，用于数据隔离',
  MODIFY COLUMN `expiresAt` datetime(3) NOT NULL COMMENT '会话过期时间，UTC',
  MODIFY COLUMN `lastActivity` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最后有效交互时间，UTC',
  MODIFY COLUMN `revealUntil` datetime(3) DEFAULT NULL COMMENT '隐藏项目授权截止时间，UTC；空表示未解锁',
  MODIFY COLUMN `backupDigest` char(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '已下载备份内容的 SHA-256 摘要',
  MODIFY COLUMN `backupExpiresAt` datetime(3) DEFAULT NULL COMMENT '备份清空确认凭据截止时间，UTC',
  COMMENT = '登录会话与隐藏项目查看授权';

ALTER TABLE `Position`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `userId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所属用户标识，用于数据隔离',
  MODIFY COLUMN `kind` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '项目类型：account 账户、asset 独立资产、debt 债务',
  MODIFY COLUMN `side` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '统计方向：asset 资产或借出应收、liability 负债或借入应付',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称',
  MODIFY COLUMN `category` varchar(40) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '项目分类代码',
  MODIFY COLUMN `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原始币种代码',
  MODIFY COLUMN `notes` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户备注，原文保留',
  MODIFY COLUMN `archived` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否归档；归档项目仍计入总额',
  MODIFY COLUMN `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间，UTC',
  MODIFY COLUMN `updatedAt` datetime(3) NOT NULL COMMENT '记录更新时间，UTC',
  MODIFY COLUMN `importedFromId` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '备份导入来源项目标识，用于重复导入识别',
  MODIFY COLUMN `hidden` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否隐藏；未解锁时不参与可见范围统计',
  MODIFY COLUMN `iconId` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '关联账户图标标识',
  COMMENT = '持有项目：账户、独立资产和借入借出债务';

ALTER TABLE `Revision`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `positionId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所属持有项目标识',
  MODIFY COLUMN `amount` decimal(24,8) NOT NULL COMMENT '变更后的原币绝对余额，不是收支增量，禁止对全部历史求和',
  MODIFY COLUMN `effectiveDate` datetime(3) NOT NULL COMMENT '北京时间业务时间对应的 UTC，精确到分钟',
  MODIFY COLUMN `notes` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户备注，原文保留',
  MODIFY COLUMN `reason` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '变更原因：初始、余额、估值、转账或借贷配对操作',
  MODIFY COLUMN `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间，UTC',
  MODIFY COLUMN `updatedAt` datetime(3) NOT NULL COMMENT '记录更新时间，UTC',
  MODIFY COLUMN `sequence` int NOT NULL AUTO_INCREMENT COMMENT '数据库自增唯一顺序，同业务时间按此排序',
  COMMENT = '余额历史：金额为变更后的绝对余额';

ALTER TABLE `PositionLink`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `sourceId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '关联来源项目标识，通常为债务',
  MODIFY COLUMN `targetId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '关联目标项目标识，通常为账户或资产',
  COMMENT = '项目关联关系，不参与金额求和';

ALTER TABLE `ExchangeRate`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `userId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所属用户标识，用于数据隔离',
  MODIFY COLUMN `currency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '原始币种代码',
  MODIFY COLUMN `baseCurrency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '本位币代码',
  MODIFY COLUMN `date` date NOT NULL COMMENT '汇率业务日期',
  MODIFY COLUMN `rate` decimal(24,12) NOT NULL COMMENT '每单位原币对应的本位币金额',
  MODIFY COLUMN `source` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '汇率来源标识，保留已有历史来源',
  COMMENT = '用户原币兑本位币的历史汇率';

ALTER TABLE `Icon`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `ownerId` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '上传用户标识；空可表示系统图标或原用户已删除',
  MODIFY COLUMN `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '显示名称',
  MODIFY COLUMN `shared` tinyint(1) NOT NULL DEFAULT '0' COMMENT '是否公开共享给已登录用户',
  MODIFY COLUMN `hash` char(64) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '规范化图标内容的 SHA-256 摘要',
  MODIFY COLUMN `data` mediumblob NOT NULL COMMENT '规范化静态 PNG 图片二进制',
  MODIFY COLUMN `source` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '可选公开来源网址',
  MODIFY COLUMN `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间，UTC',
  COMMENT = '可复用账户图标';

ALTER TABLE `Transfer`
  MODIFY COLUMN `id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '唯一标识',
  MODIFY COLUMN `importedFromId` char(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '备份导入来源项目标识，用于重复导入识别',
  MODIFY COLUMN `userId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '所属用户标识，用于数据隔离',
  MODIFY COLUMN `sourceId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '来源资产账户标识',
  MODIFY COLUMN `targetId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '目标账户或债务标识',
  MODIFY COLUMN `sourceRevisionId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '来源账户配对余额历史标识',
  MODIFY COLUMN `targetRevisionId` char(36) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '目标项目配对余额历史标识',
  MODIFY COLUMN `sourceCurrency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '来源账户币种',
  MODIFY COLUMN `targetCurrency` char(3) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '目标项目币种',
  MODIFY COLUMN `amount` decimal(24,8) NOT NULL COMMENT '本次来源账户本金金额，不是变更后余额',
  MODIFY COLUMN `received` decimal(24,8) NOT NULL COMMENT '本次目标到账金额或债务本金金额',
  MODIFY COLUMN `fee` decimal(24,8) NOT NULL COMMENT '来源币种手续费；负数表示优惠',
  MODIFY COLUMN `effectiveDate` datetime(3) NOT NULL COMMENT '北京时间业务时间对应的 UTC，精确到分钟',
  MODIFY COLUMN `notes` text COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户备注，原文保留',
  MODIFY COLUMN `createdAt` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '记录创建时间，UTC',
  MODIFY COLUMN `operation` varchar(16) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'transfer' COMMENT '操作类型：transfer 转账、borrow 借入、lend 借出、collect 收款、repay 还款',
  COMMENT = '资金往来及账户与债务的双边配对记账';
