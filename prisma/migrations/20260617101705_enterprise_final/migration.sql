/*
  Warnings:

  - You are about to drop the column `billAmount` on the `Trip` table. All the data in the column will be lost.
  - You are about to drop the column `userId` on the `Trip` table. All the data in the column will be lost.
  - You are about to drop the column `modelName` on the `Vehicle` table. All the data in the column will be lost.
  - Added the required column `driverId` to the `Trip` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE `Trip` DROP FOREIGN KEY `Trip_userId_fkey`;

-- AlterTable
ALTER TABLE `Expense` ADD COLUMN `receiptUrl` VARCHAR(191) NULL,
    ADD COLUMN `vehicleId` VARCHAR(191) NULL,
    MODIFY `tripId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Trip` DROP COLUMN `billAmount`,
    DROP COLUMN `userId`,
    ADD COLUMN `destination` VARCHAR(191) NULL,
    ADD COLUMN `driverFare` DOUBLE NOT NULL DEFAULT 0.0,
    ADD COLUMN `driverId` VARCHAR(191) NOT NULL,
    ADD COLUMN `income` DOUBLE NOT NULL DEFAULT 0.0,
    ADD COLUMN `source` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `Vehicle` DROP COLUMN `modelName`,
    ADD COLUMN `driverId` VARCHAR(191) NULL,
    ADD COLUMN `insuranceExpiry` DATETIME(3) NULL,
    ADD COLUMN `notes` TEXT NULL,
    ADD COLUMN `permitExpiry` DATETIME(3) NULL,
    ADD COLUMN `vehicleType` VARCHAR(191) NOT NULL DEFAULT 'Truck';

-- CreateTable
CREATE TABLE `Driver` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phoneNumber` VARCHAR(191) NOT NULL,
    `licenseExpiry` DATETIME(3) NULL,
    `salary` DOUBLE NOT NULL DEFAULT 0.0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Driver_phoneNumber_key`(`phoneNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditLog` (
    `id` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `details` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `message` VARCHAR(191) NOT NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Vehicle` ADD CONSTRAINT `Vehicle_driverId_fkey` FOREIGN KEY (`driverId`) REFERENCES `Driver`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Trip` ADD CONSTRAINT `Trip_driverId_fkey` FOREIGN KEY (`driverId`) REFERENCES `Driver`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `Vehicle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
