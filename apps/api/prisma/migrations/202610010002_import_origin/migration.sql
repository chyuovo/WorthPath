-- Additive migration: retain all existing positions and history.
ALTER TABLE `Position` ADD COLUMN `importedFromId` CHAR(36) NULL;
CREATE UNIQUE INDEX `Position_userId_importedFromId_key` ON `Position`(`userId`, `importedFromId`);
