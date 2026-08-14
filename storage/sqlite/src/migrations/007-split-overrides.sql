CREATE TABLE ontology_object_overrides (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value) AND json_type(value) = 'object'),
  last_commit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, primary_id),
  CHECK (COALESCE(json_extract(value, '$.kind') IN ('create', 'patch', 'delete'), 0))
);

CREATE TABLE ontology_link_overrides (
  project_id TEXT NOT NULL,
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('edge', 'slot')),
  identity_key TEXT NOT NULL CHECK (json_valid(identity_key)),
  source_type_id TEXT NOT NULL,
  source_primary_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  target_primary_id TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value) AND json_type(value) = 'object'),
  last_commit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, identity_kind, identity_key),
  CHECK (
    identity_key = CASE identity_kind
      WHEN 'edge' THEN json_array(
        source_type_id, source_primary_id, link_id, target_type_id, target_primary_id
      )
      WHEN 'slot' THEN json_array(source_type_id, source_primary_id, link_id)
    END
  ),
  CHECK (
    (identity_kind = 'edge'
      AND COALESCE(json_extract(value, '$.kind') IN ('upsert', 'delete'), 0))
    OR
    (identity_kind = 'slot'
      AND COALESCE(json_extract(value, '$.kind') IN ('set', 'clear', 'legacy-conflict'), 0)
      AND (
        json_extract(value, '$.kind') = 'legacy-conflict'
        OR (
          target_type_id = json_extract(value, '$.target.objectTypeId')
          AND target_primary_id = json_extract(value, '$.target.primaryId')
        )
      ))
  )
);

CREATE INDEX idx_ontology_link_overrides_source
  ON ontology_link_overrides(
    project_id, identity_kind, source_type_id, source_primary_id, link_id,
    target_type_id, target_primary_id
  );

CREATE INDEX idx_ontology_link_overrides_target
  ON ontology_link_overrides(project_id, target_type_id, target_primary_id);

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
SELECT project_id, 'edge', entity_key,
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
    SUM(CASE WHEN json_extract(value, '$.kind') = 'upsert' THEN 1 ELSE 0 END) AS upsert_count
  FROM ontology_overrides
  WHERE entity_kind = 'link'
  GROUP BY project_id, source_type_id, source_primary_id, link_id
), selected AS (
  SELECT scopes.*,
    COALESCE(
      (
        SELECT entity_key FROM ontology_overrides AS candidate
        WHERE candidate.project_id = scopes.project_id
          AND candidate.entity_kind = 'link'
          AND candidate.source_type_id = scopes.source_type_id
          AND candidate.source_primary_id = scopes.source_primary_id
          AND candidate.link_id = scopes.link_id
          AND json_extract(candidate.value, '$.kind') = 'upsert'
        ORDER BY candidate.updated_at DESC, candidate.entity_sort_key DESC
        LIMIT 1
      ),
      (
        SELECT entity_key FROM ontology_overrides AS candidate
        WHERE candidate.project_id = scopes.project_id
          AND candidate.entity_kind = 'link'
          AND candidate.source_type_id = scopes.source_type_id
          AND candidate.source_primary_id = scopes.source_primary_id
          AND candidate.link_id = scopes.link_id
        ORDER BY candidate.updated_at DESC, candidate.entity_sort_key DESC
        LIMIT 1
      )
    ) AS selected_key
  FROM scopes
)
INSERT INTO ontology_link_overrides (
  project_id, identity_kind, identity_key,
  source_type_id, source_primary_id, link_id, target_type_id, target_primary_id,
  value, last_commit_id, updated_at
)
SELECT selected.project_id, 'slot',
  json_array(selected.source_type_id, selected.source_primary_id, selected.link_id),
  selected.source_type_id, selected.source_primary_id, selected.link_id,
  overrides.target_type_id, overrides.target_primary_id,
  CASE
    WHEN selected.upsert_count > 1 THEN json_object('kind', 'legacy-conflict')
    WHEN selected.upsert_count = 1 THEN json_patch(
      json_object(
        'kind', 'set',
        'target', json_object(
          'objectTypeId', overrides.target_type_id,
          'primaryId', overrides.target_primary_id
        )
      ),
      CASE
        WHEN json_type(overrides.value, '$.properties') IS NOT NULL
          THEN json_object('properties', json_extract(overrides.value, '$.properties'))
        ELSE json('{}')
      END
    )
    ELSE json_object(
      'kind', 'clear',
      'target', json_object(
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
