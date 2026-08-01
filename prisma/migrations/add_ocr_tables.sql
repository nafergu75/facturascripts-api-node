-- CreateTable OCRSession
CREATE TABLE `OCRSession` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `originalFileName` VARCHAR(191) NOT NULL,
    `originalFilePath` VARCHAR(191) NOT NULL,
    `originalFileSize` INTEGER NOT NULL,
    `originalMimeType` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `ilovepdfTaskId` VARCHAR(191) NULL,
    `processingStartedAt` DATETIME(3) NULL,
    `processingCompletedAt` DATETIME(3) NULL,
    `processingTimeSeconds` INTEGER NULL,
    `ocrPdfPath` VARCHAR(191) NULL,
    `ocrPdfSize` INTEGER NULL,
    `ocrTextExtracted` LONGTEXT NULL,
    `ocrPageCount` INTEGER NULL,
    `ocrCharCount` INTEGER NULL,
    `language` VARCHAR(191) NOT NULL DEFAULT 'es',
    `invoiceType` VARCHAR(191) NOT NULL DEFAULT 'expense',
    `source` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    INDEX `OCRSession_companyId_status_idx`(`companyId`, `status`),
    INDEX `OCRSession_companyId_createdAt_idx`(`companyId`, `createdAt`),
    INDEX `OCRSession_companyId_invoiceType_idx`(`companyId`, `invoiceType`),
    INDEX `OCRSession_userId_idx`(`userId`),
    INDEX `OCRSession_status_idx`(`status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable OCRDocument
CREATE TABLE `OCRDocument` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `extractedData` JSON NULL,
    `linkedInvoiceId` VARCHAR(191) NULL,
    `linkedReaderDocument` VARCHAR(191) NULL,
    `confidenceScore` DOUBLE NULL,
    `manuallyReviewed` BOOLEAN NOT NULL DEFAULT false,
    `reviewedBy` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OCRDocument_linkedInvoiceId_key`(`linkedInvoiceId`),
    PRIMARY KEY (`id`),
    INDEX `OCRDocument_companyId_sessionId_idx`(`companyId`, `sessionId`),
    INDEX `OCRDocument_companyId_linkedInvoiceId_idx`(`companyId`, `linkedInvoiceId`),
    INDEX `OCRDocument_companyId_createdAt_idx`(`companyId`, `createdAt`),
    INDEX `OCRDocument_linkedInvoiceId_idx`(`linkedInvoiceId`),
    CONSTRAINT `OCRDocument_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `OCRSession` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
