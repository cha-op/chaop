ALTER TABLE commands ADD COLUMN target_connector_id_source TEXT NOT NULL DEFAULT 'auto';

UPDATE commands
SET target_connector_id_source = 'explicit'
WHERE target_connector_id IS NOT NULL;
