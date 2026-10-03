-- CreateTable
CREATE TABLE `AgentCall` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `grantId` CHAR(36) NOT NULL,
    `tool` VARCHAR(100) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentCall_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentCall` ADD CONSTRAINT `AgentCall_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
