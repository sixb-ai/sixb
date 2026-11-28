-- What a migration run's value steps gave each object, staged before the run starts. After the
-- point of no return it is the only copy of what their functions returned, and a resume applies it
-- without calling them again: a plain table, since an unclean restart empties an unlogged one.
-- Each JSON object is keyed by property id.
CREATE TABLE ontology_migration_staged_values (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  edits JSONB NOT NULL,
  edited_at JSONB NOT NULL,
  -- Ids a fill gives a value a patch had cleared: they leave its `unset`.
  restored JSONB NOT NULL,
  effective JSONB NOT NULL,
  -- Per unique property: `{ "from": key, "to": key }`, either null.
  unique_keys JSONB NOT NULL,
  -- Vector indexing requests, without the batch commit that queues them.
  vectors JSONB NOT NULL,
  PRIMARY KEY (project_id, run_id, object_type_id, primary_id)
);
