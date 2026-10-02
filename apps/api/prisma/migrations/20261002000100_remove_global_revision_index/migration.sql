-- Bounded per-position queries replace the global scan. EXPLAIN ANALYZE showed
-- this competing index could scan other accounts before finding a match.
DROP INDEX `Revision_effectiveDate_sequence_idx` ON `Revision`;
