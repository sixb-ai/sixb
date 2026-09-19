ALTER TABLE ontology_sources ADD COLUMN base_materialization_id TEXT;
ALTER TABLE ontology_sources ADD COLUMN base_commit_id TEXT
  CHECK ((base_materialization_id IS NULL) = (base_commit_id IS NULL));

CREATE TABLE ontology_source_roots (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  root_sort_key TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('object', 'link')),
  root_key TEXT NOT NULL CHECK (json_valid(root_key)),
  root TEXT NOT NULL CHECK (json_valid(root)),
  staging_ordinal INTEGER NOT NULL CHECK (staging_ordinal >= 0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  retired_at TEXT,
  PRIMARY KEY (project_id, source_id, materialization_id, root_sort_key),
  UNIQUE (project_id, source_id, materialization_id, staging_ordinal),
  FOREIGN KEY (project_id, source_id, materialization_id)
    REFERENCES ontology_sources(project_id, source_id, materialization_id) ON DELETE RESTRICT,
  CHECK (active = 0 OR (deleted = 0 AND retired_at IS NULL))
);
CREATE UNIQUE INDEX idx_ontology_source_roots_active
  ON ontology_source_roots (project_id, source_id, root_sort_key) WHERE active = 1;
CREATE INDEX idx_ontology_source_roots_lookup
  ON ontology_source_roots (project_id, root_sort_key, source_id) WHERE active = 1;
CREATE INDEX idx_ontology_source_roots_cleanup
  ON ontology_source_roots (project_id, retired_at, source_id, materialization_id, root_sort_key)
  WHERE active = 0 AND retired_at IS NOT NULL;

INSERT INTO ontology_source_roots (
  project_id, source_id, materialization_id, root_sort_key, root_kind, root_key, root,
  staging_ordinal, active, retired_at
)
SELECT DISTINCT rows.project_id, rows.source_id, rows.materialization_id,
  rows.root_sort_key, rows.root_kind, rows.root_key, rows.root, rows.staging_ordinal,
  sources.status = 'active', sources.terminal_at
FROM ontology_source_rows AS rows
JOIN ontology_sources AS sources USING (project_id, source_id, materialization_id);

ANALYZE ontology_source_roots;

ALTER TABLE projection_runs ADD COLUMN source_changes_read INTEGER
  CHECK (source_changes_read IS NULL OR source_changes_read >= 0);
