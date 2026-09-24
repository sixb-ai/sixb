-- Intervention actors were stored as { principalType, principalId }. Rewrite them to the
-- canonical Principal shape { type, id } used by every other stored principal.
UPDATE workflow_interventions
SET submitted_by = jsonb_build_object(
  'type', submitted_by->>'principalType',
  'id', submitted_by->>'principalId'
)
WHERE submitted_by->>'principalType' IS NOT NULL;

UPDATE workflow_interventions
SET cancelled_by = jsonb_build_object(
  'type', cancelled_by->>'principalType',
  'id', cancelled_by->>'principalId'
)
WHERE cancelled_by->>'principalType' IS NOT NULL;
