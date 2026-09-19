ALTER TABLE ontology_sources ADD COLUMN base_materialization_id TEXT;
ALTER TABLE ontology_sources ADD COLUMN base_commit_id TEXT;
ALTER TABLE ontology_sources ADD CHECK ((base_materialization_id IS NULL) = (base_commit_id IS NULL));

-- A root selects one complete set of assertions. Unchanged roots keep their original version;
-- activation only retires/replaces affected references, under the source commit fence.
CREATE TABLE ontology_source_roots (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  root_sort_key TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('object', 'link')),
  root_key JSONB NOT NULL,
  root JSONB NOT NULL,
  staging_ordinal BIGINT NOT NULL CHECK (staging_ordinal >= 0),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, source_id, materialization_id, root_sort_key),
  UNIQUE (project_id, source_id, materialization_id, staging_ordinal),
  FOREIGN KEY (project_id, source_id, materialization_id)
    REFERENCES ontology_sources(project_id, source_id, materialization_id) ON DELETE RESTRICT,
  CHECK (NOT active OR (NOT deleted AND retired_at IS NULL))
);
CREATE UNIQUE INDEX idx_ontology_source_roots_active
  ON ontology_source_roots (project_id, source_id, root_sort_key) WHERE active;
CREATE INDEX idx_ontology_source_roots_lookup
  ON ontology_source_roots (project_id, root_sort_key, source_id) WHERE active;
CREATE INDEX idx_ontology_source_roots_cleanup
  ON ontology_source_roots (project_id, retired_at, source_id, materialization_id, root_sort_key)
  WHERE NOT active AND retired_at IS NOT NULL;

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

ALTER TABLE projection_runs ADD COLUMN source_changes_read BIGINT
  CHECK (source_changes_read IS NULL OR source_changes_read >= 0);
