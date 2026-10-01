-- Source versions get a compact surrogate key; roots and rows stop repeating the text triple.
ALTER TABLE ontology_sources ADD COLUMN version_id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE ontology_sources ADD CONSTRAINT ontology_sources_version_id_key UNIQUE (version_id);

ALTER TABLE ontology_source_rows RENAME TO legacy_ontology_source_rows;
ALTER TABLE ontology_source_roots RENAME TO legacy_ontology_source_roots;
-- Index names are schema-wide: free them for the new tables.
DO $$
DECLARE
  legacy record;
BEGIN
  FOR legacy IN
    SELECT index_class.relname AS name
    FROM pg_index
    JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = pg_index.indrelid
    WHERE table_class.relnamespace = current_schema()::regnamespace
      AND table_class.relname IN ('legacy_ontology_source_rows', 'legacy_ontology_source_roots')
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', legacy.name, left('legacy_' || legacy.name, 63));
  END LOOP;
END $$;

-- A root is live while its version is published (active or superseded), it is not retired and
-- it is not a deletion. Activation therefore writes only the roots it replaces, never its own.
-- `root_key` is the canonical key; "C" orders it by its UTF-8 bytes.
CREATE TABLE ontology_source_roots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id BIGINT NOT NULL REFERENCES ontology_sources (version_id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL,
  root_key TEXT COLLATE "C" NOT NULL,
  staging_ordinal BIGINT NOT NULL CHECK (staging_ordinal >= 0),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  retired_at TIMESTAMPTZ,
  CONSTRAINT ontology_source_roots_key UNIQUE (version_id, root_key),
  CONSTRAINT ontology_source_roots_ordinal UNIQUE (version_id, staging_ordinal)
);
CREATE INDEX idx_ontology_source_roots_live
  ON ontology_source_roots (project_id, root_key) WHERE retired_at IS NULL AND NOT deleted;
CREATE INDEX idx_ontology_source_roots_retired
  ON ontology_source_roots (project_id, retired_at) WHERE retired_at IS NOT NULL;

-- A row's identity lives in its typed columns; `payload` is the assertion without kind and ref.
CREATE TABLE ontology_source_rows (
  root_id BIGINT NOT NULL REFERENCES ontology_source_roots (id) ON DELETE RESTRICT,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  object_type_id TEXT,
  primary_id TEXT,
  source_type_id TEXT,
  source_primary_id TEXT,
  link_id TEXT,
  target_type_id TEXT,
  target_primary_id TEXT,
  payload JSONB,
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
SELECT versions.version_id, roots.project_id,
  convert_from(decode(roots.root_sort_key, 'hex'), 'UTF8'), roots.staging_ordinal, roots.deleted,
  CASE
    WHEN roots.active THEN NULL
    WHEN roots.retired_at IS NOT NULL THEN roots.retired_at
    WHEN versions.status IN ('active', 'superseded') THEN versions.updated_at
  END
FROM legacy_ontology_source_roots AS roots
JOIN ontology_sources AS versions USING (project_id, source_id, materialization_id);

INSERT INTO ontology_source_rows (
  root_id, entity_kind, object_type_id, primary_id,
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id, payload
)
SELECT roots.id, rows.entity_kind, rows.object_type_id, rows.primary_id,
  rows.source_type_id, rows.source_primary_id, rows.link_id, rows.target_type_id,
  rows.target_primary_id, NULLIF(rows.assertion - 'kind' - 'ref', '{}'::jsonb)
FROM legacy_ontology_source_rows AS rows
JOIN ontology_sources AS versions USING (project_id, source_id, materialization_id)
JOIN ontology_source_roots AS roots
  ON roots.version_id = versions.version_id
  AND roots.root_key = convert_from(decode(rows.root_sort_key, 'hex'), 'UTF8');

DO $$
BEGIN
  IF (SELECT count(*) FROM legacy_ontology_source_roots)
      <> (SELECT count(*) FROM ontology_source_roots)
    OR (SELECT count(*) FROM legacy_ontology_source_rows)
      <> (SELECT count(*) FROM ontology_source_rows) THEN
    RAISE EXCEPTION 'Source roots or rows were lost while compacting source storage.';
  END IF;
END $$;

DROP TABLE legacy_ontology_source_rows;
DROP TABLE legacy_ontology_source_roots;
ANALYZE ontology_sources, ontology_source_roots, ontology_source_rows;
