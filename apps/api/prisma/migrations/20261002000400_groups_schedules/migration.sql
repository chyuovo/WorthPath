ALTER TABLE `Position` ADD COLUMN `groupName` VARCHAR(60) NOT NULL DEFAULT '' COMMENT '自定义账户分组';
CREATE TABLE `Schedule` (
 `id` CHAR(36) NOT NULL, `userId` CHAR(36) NOT NULL, `importedFromId` CHAR(36) NULL,
 `name` VARCHAR(100) NOT NULL, `operation` VARCHAR(16) NOT NULL,
 `sourceId` CHAR(36) NOT NULL, `targetId` CHAR(36) NULL,
 `amount` DECIMAL(24,8) NOT NULL, `received` DECIMAL(24,8) NOT NULL,
 `nextAt` DATETIME(3) NOT NULL, `intervalDays` INTEGER NOT NULL,
 `enabled` BOOLEAN NOT NULL DEFAULT true, `completed` BOOLEAN NOT NULL DEFAULT false, `notes` TEXT NOT NULL,
 PRIMARY KEY (`id`), INDEX `Schedule_userId_enabled_nextAt_idx` (`userId`,`enabled`,`nextAt`),
 UNIQUE INDEX `Schedule_userId_importedFromId_key` (`userId`,`importedFromId`),
 CONSTRAINT `Schedule_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
