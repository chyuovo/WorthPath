CREATE TABLE `Icon` (
  `id` CHAR(36) NOT NULL,
  `ownerId` CHAR(36) NULL,
  `name` VARCHAR(100) NOT NULL,
  `shared` BOOLEAN NOT NULL DEFAULT false,
  `hash` CHAR(64) NOT NULL,
  `data` MEDIUMBLOB NOT NULL,
  `source` VARCHAR(500) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `Icon_ownerId_hash_shared_key` (`ownerId`, `hash`, `shared`),
  INDEX `Icon_shared_name_idx` (`shared`, `name`),
  CONSTRAINT `Icon_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `User` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `Position` ADD COLUMN `iconId` CHAR(36) NULL;
ALTER TABLE `Position` ADD CONSTRAINT `Position_iconId_fkey` FOREIGN KEY (`iconId`) REFERENCES `Icon` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
