-- The shape the stored objects of each type fit: its properties' schemas and flags and its links,
-- as JSON. A deploy compares it with the code's before the new code serves, and records the code's
-- once the data fits.
CREATE TABLE ontology_type_shapes (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  shape JSONB NOT NULL CHECK (jsonb_typeof(shape) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, object_type_id)
);
