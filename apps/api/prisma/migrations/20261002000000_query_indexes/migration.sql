CREATE INDEX `Revision_positionId_effectiveDate_sequence_idx` ON `Revision` (`positionId`, `effectiveDate`, `sequence`);
CREATE INDEX `Revision_effectiveDate_sequence_idx` ON `Revision` (`effectiveDate`, `sequence`);
CREATE INDEX `Revision_positionId_reason_effectiveDate_sequence_idx` ON `Revision` (`positionId`, `reason`, `effectiveDate`, `sequence`);
DROP INDEX `Revision_positionId_effectiveDate_idx` ON `Revision`;
CREATE INDEX `Transfer_userId_effectiveDate_id_idx` ON `Transfer` (`userId`, `effectiveDate`, `id`);
DROP INDEX `Transfer_userId_effectiveDate_idx` ON `Transfer`;
