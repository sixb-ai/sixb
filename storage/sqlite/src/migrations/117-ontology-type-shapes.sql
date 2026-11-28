-- The shape the stored objects of each type fit: its properties' schemas and flags and its links,
-- as JSON. A deploy compares it with the code's before the new code serves, and records the code's
-- once the data fits. `previous_shape` is the one recorded before it, which the previous release's
-- roles may still start on.
CREATE TABLE ontology_type_shapes (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  shape TEXT NOT NULL CHECK (json_valid(shape) AND json_type(shape) = 'object'),
  previous_shape TEXT CHECK (
    previous_shape IS NULL OR (json_valid(previous_shape) AND json_type(previous_shape) = 'object')
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id)
);
