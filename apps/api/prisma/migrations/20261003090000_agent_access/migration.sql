-- CreateTable
CREATE TABLE `AgentPolicy` (
    `userId` CHAR(36) NOT NULL,
    `mode` VARCHAR(16) NOT NULL DEFAULT 'draft',

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentClient` (
    `id` CHAR(36) NOT NULL,
    `metadata` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentAuthorization` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NULL,
    `clientId` CHAR(36) NOT NULL,
    `parameters` JSON NOT NULL,
    `codeDigest` CHAR(64) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',

    UNIQUE INDEX `AgentAuthorization_codeDigest_key`(`codeDigest`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentGrant` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `clientId` CHAR(36) NULL,
    `name` VARCHAR(100) NOT NULL,
    `scopes` JSON NOT NULL,
    `resource` VARCHAR(500) NOT NULL,
    `accessDigest` CHAR(64) NOT NULL,
    `refreshDigest` CHAR(64) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `refreshExpiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `sessionId` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AgentGrant_accessDigest_key`(`accessDigest`),
    UNIQUE INDEX `AgentGrant_refreshDigest_key`(`refreshDigest`),
    INDEX `AgentGrant_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentOperation` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `grantId` CHAR(36) NOT NULL,
    `key` VARCHAR(128) NOT NULL,
    `hash` CHAR(64) NOT NULL,
    `tool` VARCHAR(100) NOT NULL,
    `parameters` JSON NOT NULL,
    `snapshot` CHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `expiresAt` DATETIME(3) NOT NULL,
    `result` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `AgentOperation_userId_createdAt_idx`(`userId`, `createdAt`),
    UNIQUE INDEX `AgentOperation_userId_key_key`(`userId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentPolicy` ADD CONSTRAINT `AgentPolicy_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentAuthorization` ADD CONSTRAINT `AgentAuthorization_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentGrant` ADD CONSTRAINT `AgentGrant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentOperation` ADD CONSTRAINT `AgentOperation_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
