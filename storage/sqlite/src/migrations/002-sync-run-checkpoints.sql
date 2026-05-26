ALTER TABLE sync_runs ADD COLUMN checkpoint TEXT;
ALTER TABLE sync_runs DROP COLUMN metadata;
