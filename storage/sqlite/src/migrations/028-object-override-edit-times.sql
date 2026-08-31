ALTER TABLE ontology_object_overrides
ADD COLUMN edited_at TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(edited_at) AND json_type(edited_at) = 'object');
