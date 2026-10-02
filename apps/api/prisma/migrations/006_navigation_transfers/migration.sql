ALTER TABLE `User` ADD COLUMN `hiddenMenus` VARCHAR(128) NOT NULL DEFAULT '', DROP COLUMN `showSidebar`;
CREATE TABLE `Transfer` (
 `id` CHAR(36) NOT NULL, `importedFromId` CHAR(36) NULL, `userId` CHAR(36) NOT NULL,
 `sourceId` CHAR(36) NOT NULL, `targetId` CHAR(36) NOT NULL,
 `sourceRevisionId` CHAR(36) NOT NULL, `targetRevisionId` CHAR(36) NOT NULL,
 `sourceCurrency` CHAR(3) NOT NULL, `targetCurrency` CHAR(3) NOT NULL,
 `amount` DECIMAL(24,8) NOT NULL, `received` DECIMAL(24,8) NOT NULL, `fee` DECIMAL(24,8) NOT NULL,
 `effectiveDate` DATETIME(3) NOT NULL, `notes` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`), UNIQUE INDEX `Transfer_sourceRevisionId_key` (`sourceRevisionId`), UNIQUE INDEX `Transfer_targetRevisionId_key` (`targetRevisionId`),
 UNIQUE INDEX `Transfer_userId_importedFromId_key` (`userId`,`importedFromId`), INDEX `Transfer_userId_effectiveDate_idx` (`userId`,`effectiveDate`),
 CONSTRAINT `Transfer_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `Transfer_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `Position` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT `Transfer_targetId_fkey` FOREIGN KEY (`targetId`) REFERENCES `Position` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
