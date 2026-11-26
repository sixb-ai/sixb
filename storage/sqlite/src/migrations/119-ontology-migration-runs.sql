-- One row per run: what it applies (the shapes it starts from and leaves, its migrations and their
-- hashes, each type's steps), fixed when it starts.
CREATE TABLE ontology_migration_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applying', 'applied')),
  started_at TEXT NOT NULL,
  applied_at TEXT,
  plan TEXT NOT NULL CHECK (json_valid(plan) AND json_type(plan) = 'object'),
  PRIMARY KEY (project_id, id),
  CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
-- At most one open run per project.
CREATE UNIQUE INDEX ontology_migration_runs_open
  ON ontology_migration_runs (project_id) WHERE status = 'applying';

-- A run's lanes, each an independent stream of batches over rows no other lane touches: a range of
-- a type's objects, its derived rows, or its source rows. Each batch saves where its lane's next one
-- starts in its own transaction; `cursor` is NULL once the lane is done.
CREATE TABLE ontology_migration_run_lanes (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  lane TEXT NOT NULL,
  cursor TEXT,
  batches INTEGER NOT NULL DEFAULT 0 CHECK (batches >= 0),
  counts TEXT NOT NULL CHECK (json_valid(counts) AND json_type(counts) = 'object'),
  PRIMARY KEY (project_id, run_id, ordinal)
);

-- The migrations each type is past: run there, or recorded past while not pending. A migration runs
-- at most once per database, so an old convert doesn't re-arm when its property narrows again.
CREATE TABLE ontology_migrations_settled (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, migration_id)
);
