-- Intervention actors were stored as { principalType, principalId }. Rewrite them to the
-- canonical Principal shape { type, id } used by every other stored principal.
UPDATE workflow_interventions
SET submitted_by = json_object(
  'type', json_extract(submitted_by, '$.principalType'),
  'id', json_extract(submitted_by, '$.principalId')
)
WHERE json_extract(submitted_by, '$.principalType') IS NOT NULL;

UPDATE workflow_interventions
SET cancelled_by = json_object(
  'type', json_extract(cancelled_by, '$.principalType'),
  'id', json_extract(cancelled_by, '$.principalId')
)
WHERE json_extract(cancelled_by, '$.principalType') IS NOT NULL;
