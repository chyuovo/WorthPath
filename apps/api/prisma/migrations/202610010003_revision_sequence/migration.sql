-- Preserve all amounts and dates; permit multiple independently ordered updates per day.
ALTER TABLE `Revision` ADD COLUMN `sequence` INTEGER NOT NULL AUTO_INCREMENT, ADD UNIQUE INDEX `Revision_sequence_key` (`sequence`);
CREATE INDEX `Revision_positionId_effectiveDate_idx` ON `Revision`(`positionId`, `effectiveDate`);
DROP INDEX `Revision_positionId_effectiveDate_key` ON `Revision`;
