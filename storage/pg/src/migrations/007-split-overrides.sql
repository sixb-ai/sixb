CREATE TABLE ontology_object_overrides (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  value JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  last_commit_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, object_type_id, primary_id),
  CHECK (COALESCE(value->>'kind' IN ('create', 'patch', 'delete'), false))
);

CREATE TABLE ontology_link_overrides (
  project_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('edge', 'slot')),
  identity_key JSONB NOT NULL,
  source_type_id TEXT NOT NULL,
  source_primary_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  target_primary_id TEXT NOT NULL,
  value JSONB NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  last_commit_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, identity_kind, identity_key),
  CHECK (
    identity_key = CASE identity_kind
      WHEN 'edge' THEN jsonb_build_array(
        source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
      )
      WHEN 'slot' THEN jsonb_build_array(source_type_id, source_primary_id, link_id)
    END
  ),
  CHECK (
    (identity_kind = 'edge' AND COALESCE(value->>'kind' IN ('upsert', 'delete'), false))
    OR
    (identity_kind = 'slot'
      AND COALESCE(value->>'kind' IN ('set', 'clear', 'legacy-conflict'), false)
      AND (
        value->>'kind' = 'legacy-conflict'
        OR (
          target_type_id = value->'target'->>'objectTypeId'
          AND target_primary_id = value->'target'->>'primaryId'
        )
      ))
  )
);

CREATE INDEX idx_ontology_link_overrides_source
  ON ontology_link_overrides (
    project_id, identity_kind, source_type_id, source_primary_id, link_id,
    target_type_id, target_primary_id
  );

CREATE INDEX idx_ontology_link_overrides_target
  ON ontology_link_overrides (project_id, target_type_id, target_primary_id);

INSERT INTO ontology_object_overrides (
  project_id, object_type_id, primary_id, value, last_commit_id, updated_at
)
SELECT project_id, object_type_id, primary_id, value, last_commit_id, updated_at
FROM ontology_overrides
WHERE entity_kind = 'object';

INSERT INTO ontology_link_overrides (
  project_id, identity_kind, identity_key,
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
  value, last_commit_id, updated_at
)
SELECT project_id, 'edge', jsonb_build_array(
    source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
  ),
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
  value, last_commit_id, updated_at
FROM ontology_overrides
WHERE entity_kind = 'link';

-- Storage migrations do not have access to the ontology cardinality. Derive a slot candidate for
-- every legacy link scope; the runtime selects edge or slot authority from the registered ontology.
-- A single upsert is an unambiguous set and a delete-only scope is an unambiguous clear. Multiple
-- upserts are preserved as an explicit conflict instead of selecting a target arbitrarily.
WITH scopes AS (
  SELECT project_id, source_type_id, source_primary_id, link_id,
    COUNT(*) FILTER (WHERE value->>'kind' = 'upsert') AS upsert_count
  FROM ontology_overrides
  WHERE entity_kind = 'link'
  GROUP BY project_id, source_type_id, source_primary_id, link_id
), selected AS (
  SELECT scopes.*, COALESCE(upsert.entity_key, anchor.entity_key) AS selected_key
  FROM scopes
  LEFT JOIN LATERAL (
    SELECT candidate.entity_key
    FROM ontology_overrides AS candidate
    WHERE candidate.project_id = scopes.project_id
      AND candidate.entity_kind = 'link'
      AND candidate.source_type_id = scopes.source_type_id
      AND candidate.source_primary_id = scopes.source_primary_id
      AND candidate.link_id = scopes.link_id
      AND candidate.value->>'kind' = 'upsert'
    ORDER BY candidate.updated_at DESC, candidate.entity_sort_key DESC
    LIMIT 1
  ) AS upsert ON true
  LEFT JOIN LATERAL (
    SELECT candidate.entity_key
    FROM ontology_overrides AS candidate
    WHERE candidate.project_id = scopes.project_id
      AND candidate.entity_kind = 'link'
      AND candidate.source_type_id = scopes.source_type_id
      AND candidate.source_primary_id = scopes.source_primary_id
      AND candidate.link_id = scopes.link_id
    ORDER BY candidate.updated_at DESC, candidate.entity_sort_key DESC
    LIMIT 1
  ) AS anchor ON true
)
INSERT INTO ontology_link_overrides (
  project_id, identity_kind, identity_key,
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
  value, last_commit_id, updated_at
)
SELECT selected.project_id, 'slot',
  jsonb_build_array(selected.source_type_id, selected.source_primary_id, selected.link_id),
  selected.source_type_id, selected.source_primary_id, selected.link_id,
  overrides.target_type_id, overrides.target_primary_id,
  CASE
    WHEN selected.upsert_count > 1 THEN jsonb_build_object('kind', 'legacy-conflict')
    WHEN selected.upsert_count = 1 THEN
      jsonb_build_object(
        'kind', 'set',
        'target', jsonb_build_object(
          'objectTypeId', overrides.target_type_id,
          'primaryId', overrides.target_primary_id
        )
      ) || CASE
        WHEN overrides.value ? 'properties'
          THEN jsonb_build_object('properties', overrides.value->'properties')
        ELSE '{}'::jsonb
      END
    ELSE jsonb_build_object(
      'kind', 'clear',
      'target', jsonb_build_object(
        'objectTypeId', overrides.target_type_id,
        'primaryId', overrides.target_primary_id
      )
    )
  END,
  overrides.last_commit_id,
  overrides.updated_at
FROM selected
JOIN ontology_overrides AS overrides
  ON overrides.project_id = selected.project_id
 AND overrides.entity_kind = 'link'
 AND overrides.entity_key = selected.selected_key;

DROP TABLE ontology_overrides;
