ALTER TABLE `User` ADD COLUMN `showSidebar` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `idleMinutes` INTEGER NOT NULL DEFAULT 30;
ALTER TABLE `Session` ADD COLUMN `lastActivity` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `revealUntil` DATETIME(3) NULL,
  ADD COLUMN `backupDigest` CHAR(64) NULL,
  ADD COLUMN `backupExpiresAt` DATETIME(3) NULL;
ALTER TABLE `Position` ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `Revision` MODIFY COLUMN `effectiveDate` DATETIME(3) NOT NULL;
-- Existing date-only entries represent midnight in Asia/Hong_Kong.
UPDATE `Revision` SET `effectiveDate` = DATE_SUB(`effectiveDate`, INTERVAL 8 HOUR);
