ALTER TABLE ontology_object_overrides
ADD COLUMN edited_at JSONB NOT NULL DEFAULT '{}'::jsonb
CHECK (jsonb_typeof(edited_at) = 'object');
