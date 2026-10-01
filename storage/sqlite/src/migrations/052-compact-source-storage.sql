-- Source versions get a compact surrogate key; roots and rows stop repeating the text triple.
-- SQLite cannot add a key column to a table, so the three source tables are rebuilt. Index
-- names are schema-wide: the old ones are dropped first to free them.
DROP INDEX idx_ontology_sources_active;
DROP INDEX idx_ontology_sources_run_candidate;
DROP INDEX idx_ontology_sources_cleanup;
DROP INDEX idx_ontology_sources_run;
DROP INDEX idx_ontology_source_roots_active;
DROP INDEX idx_ontology_source_roots_lookup;
DROP INDEX idx_ontology_source_roots_cleanup;
DROP INDEX idx_ontology_source_rows_root;
DROP INDEX idx_ontology_source_rows_staging_ordinal;
DROP INDEX idx_ontology_source_rows_entity_sort;
DROP INDEX idx_ontology_source_rows_object;
DROP INDEX idx_ontology_source_rows_link_source;
DROP INDEX idx_ontology_source_rows_link_target;
ALTER TABLE ontology_source_rows RENAME TO legacy_ontology_source_rows;
ALTER TABLE ontology_source_roots RENAME TO legacy_ontology_source_roots;
ALTER TABLE ontology_sources RENAME TO legacy_ontology_sources;

CREATE TABLE ontology_sources (
  version_id INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  projection_run_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link')),
  protocol TEXT NOT NULL CHECK (protocol = 'replacement'),
  status TEXT NOT NULL CHECK (
    status IN ('staging', 'ready', 'active', 'superseded', 'abandoned')
  ),
  execution_token TEXT,
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  dataset_version_created_at TEXT NOT NULL,
  projection_revision TEXT NOT NULL,
  ownership_hash TEXT NOT NULL,
  ontology_revision TEXT NOT NULL,
  root_count INTEGER CHECK (root_count IS NULL OR root_count >= 0),
  assertion_count INTEGER CHECK (assertion_count IS NULL OR assertion_count >= 0),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  activated_at TEXT,
  terminal_at TEXT,
  last_commit_id TEXT,
  updated_at TEXT NOT NULL,
  base_materialization_id TEXT,
  base_commit_id TEXT,
  UNIQUE (project_id, source_id, materialization_id),
  CHECK ((base_materialization_id IS NULL) = (base_commit_id IS NULL)),
  CHECK ((root_count IS NULL) = (assertion_count IS NULL)),
  CHECK ((root_count IS NULL) = (ready_at IS NULL)),
  CHECK ((status IN ('staging', 'ready')) = (execution_token IS NOT NULL)),
  CHECK (
    (status = 'staging' AND ready_at IS NULL)
    OR (status IN ('ready', 'active', 'superseded') AND ready_at IS NOT NULL)
    OR status = 'abandoned'
  ),
  CHECK ((status IN ('active', 'superseded')) = (activated_at IS NOT NULL)),
  CHECK ((status IN ('active', 'superseded')) = (last_commit_id IS NOT NULL)),
  CHECK ((status IN ('superseded', 'abandoned')) = (terminal_at IS NOT NULL)),
  CHECK (ready_at IS NULL OR created_at <= ready_at),
  CHECK (activated_at IS NULL OR (ready_at IS NOT NULL AND ready_at <= activated_at)),
  CHECK (terminal_at IS NULL OR created_at <= terminal_at),
  CHECK (terminal_at IS NULL OR ready_at IS NULL OR ready_at <= terminal_at),
  CHECK (terminal_at IS NULL OR activated_at IS NULL OR activated_at <= terminal_at),
  CHECK (created_at <= updated_at)
);
INSERT INTO ontology_sources (
  project_id, source_id, materialization_id, projection_run_id, projection_kind, protocol,
  status, execution_token, dataset_id, dataset_version_id, dataset_version_created_at,
  projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
  created_at, ready_at, activated_at, terminal_at, last_commit_id, updated_at,
  base_materialization_id, base_commit_id
)
SELECT project_id, source_id, materialization_id, projection_run_id, projection_kind, protocol,
  status, execution_token, dataset_id, dataset_version_id, dataset_version_created_at,
  projection_revision, ownership_hash, ontology_revision, root_count, assertion_count,
  created_at, ready_at, activated_at, terminal_at, last_commit_id, updated_at,
  base_materialization_id, base_commit_id
FROM legacy_ontology_sources
ORDER BY rowid;
CREATE UNIQUE INDEX idx_ontology_sources_active
  ON ontology_sources(project_id, source_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX idx_ontology_sources_run_candidate
  ON ontology_sources(project_id, projection_run_id)
  WHERE status IN ('staging', 'ready');
CREATE INDEX idx_ontology_sources_cleanup
  ON ontology_sources(project_id, status, terminal_at, source_id, materialization_id);
CREATE INDEX idx_ontology_sources_run
  ON ontology_sources(project_id, projection_run_id);

-- A root is live while its version is published (active or superseded), it is not retired and
-- it is not a deletion. Activation therefore writes only the roots it replaces, never its own.
-- `root_key` is the canonical key; SQLite's default BINARY collation orders it by its UTF-8 bytes.
CREATE TABLE ontology_source_roots (
  id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES ontology_sources (version_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  staging_ordinal INTEGER NOT NULL CHECK (staging_ordinal >= 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  retired_at TEXT,
  CONSTRAINT ontology_source_roots_key UNIQUE (version_id, root_key),
  CONSTRAINT ontology_source_roots_ordinal UNIQUE (version_id, staging_ordinal)
);
CREATE INDEX idx_ontology_source_roots_live
  ON ontology_source_roots (project_id, root_key) WHERE retired_at IS NULL AND deleted = 0;
CREATE INDEX idx_ontology_source_roots_retired
  ON ontology_source_roots (project_id, retired_at) WHERE retired_at IS NOT NULL;

-- A row's identity lives in its typed columns; `payload` is the assertion without kind and ref.
CREATE TABLE ontology_source_rows (
  root_id INTEGER NOT NULL REFERENCES ontology_source_roots (id) ON DELETE RESTRICT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  object_type_id TEXT,
  primary_id TEXT,
  source_type_id TEXT,
  source_primary_id TEXT,
  link_id TEXT,
  target_type_id TEXT,
  target_primary_id TEXT,
  payload TEXT CHECK (json_valid(payload)),
  CHECK (
    (
      entity_kind = 'object'
      AND object_type_id IS NOT NULL AND primary_id IS NOT NULL
      AND source_type_id IS NULL AND source_primary_id IS NULL AND link_id IS NULL
      AND target_type_id IS NULL AND target_primary_id IS NULL
    )
    OR
    (
      entity_kind = 'link'
      AND object_type_id IS NULL AND primary_id IS NULL
      AND source_type_id IS NOT NULL AND source_primary_id IS NOT NULL AND link_id IS NOT NULL
      AND target_type_id IS NOT NULL AND target_primary_id IS NOT NULL
    )
  )
);
CREATE INDEX idx_ontology_source_rows_root ON ontology_source_rows (root_id);
CREATE INDEX idx_ontology_source_rows_link_source
  ON ontology_source_rows (source_type_id, source_primary_id, link_id)
  WHERE entity_kind = 'link';
CREATE INDEX idx_ontology_source_rows_link_target
  ON ontology_source_rows (target_type_id, target_primary_id)
  WHERE entity_kind = 'link';

-- A published root that was not active is retired, so liveness stays exactly what it was.
INSERT INTO ontology_source_roots (
  version_id, project_id, root_key, staging_ordinal, deleted, retired_at
)
SELECT versions.version_id, roots.project_id, roots.root_key, roots.staging_ordinal,
  roots.deleted,
  CASE
    WHEN roots.active = 1 THEN NULL
    WHEN roots.retired_at IS NOT NULL THEN roots.retired_at
    WHEN versions.status IN ('active', 'superseded') THEN versions.updated_at
  END
FROM legacy_ontology_source_roots AS roots
JOIN ontology_sources AS versions USING (project_id, source_id, materialization_id)
ORDER BY versions.version_id, roots.staging_ordinal;

INSERT INTO ontology_source_rows (
  root_id, entity_kind, object_type_id, primary_id,
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload
)
SELECT roots.id, rows.entity_kind, rows.object_type_id, rows.primary_id,
  rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
  rows.target_primary_id, NULLIF(json_remove(rows.assertion, '$.kind', '$.ref'), '{}')
FROM legacy_ontology_source_rows AS rows
JOIN ontology_sources AS versions USING (project_id, source_id, materialization_id)
JOIN ontology_source_roots AS roots
  ON roots.version_id = versions.version_id AND roots.root_key = rows.root_key
ORDER BY roots.id;

DROP TABLE legacy_ontology_source_rows;
DROP TABLE legacy_ontology_source_roots;
DROP TABLE legacy_ontology_sources;
-- No ANALYZE: nothing refreshes SQLite statistics afterwards, and on a fresh install they would
-- describe empty tables forever and steer the planner to partial indexes over primary keys.
