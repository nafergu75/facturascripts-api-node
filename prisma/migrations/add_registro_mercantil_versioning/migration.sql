-- Agregar campos de versionado y caducidad a LegalizationPackage
ALTER TABLE `LegalizationPackage` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `LegalizationPackage` ADD COLUMN `expiresAt` DATETIME NULL;
ALTER TABLE `LegalizationPackage` ADD COLUMN `isLatestVersion` BOOLEAN NOT NULL DEFAULT true;

-- Crear índices para búsquedas eficientes
CREATE INDEX `LegalizationPackage_companyId_isLatestVersion_idx`
  ON `LegalizationPackage` (`companyId`, `isLatestVersion`);
CREATE INDEX `LegalizationPackage_companyId_expiresAt_idx`
  ON `LegalizationPackage` (`companyId`, `expiresAt`);

-- Agregar campos de versionado y caducidad a AnnualAccounts
ALTER TABLE `AnnualAccounts` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;
ALTER TABLE `AnnualAccounts` ADD COLUMN `expiresAt` DATETIME NULL;
ALTER TABLE `AnnualAccounts` ADD COLUMN `isLatestVersion` BOOLEAN NOT NULL DEFAULT true;

-- Crear índices para búsquedas eficientes
CREATE INDEX `AnnualAccounts_companyId_isLatestVersion_idx`
  ON `AnnualAccounts` (`companyId`, `isLatestVersion`);
CREATE INDEX `AnnualAccounts_companyId_expiresAt_idx`
  ON `AnnualAccounts` (`companyId`, `expiresAt`);
