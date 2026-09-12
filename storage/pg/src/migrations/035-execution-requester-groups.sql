ALTER TABLE executions ADD COLUMN requester_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Keep historical admission snapshots; never reconstruct them from current memberships.
WITH RECURSIVE attribution(project_id, id, groups) AS (
  SELECT e.project_id, e.id, COALESCE(w.requester_group_ids, a.requester_group_ids, '[]'::jsonb)
  FROM executions e
  LEFT JOIN workflow_runs w ON w.project_id = e.project_id AND w.execution_id = e.id
  LEFT JOIN agent_runs a ON a.project_id = e.project_id AND a.execution_id = e.id
  WHERE e.parent_execution_id IS NULL
  UNION ALL
  SELECT e.project_id, e.id, COALESCE(w.requester_group_ids, a.requester_group_ids, p.groups)
  FROM executions e
  JOIN attribution p ON p.project_id = e.project_id AND p.id = e.parent_execution_id
  LEFT JOIN workflow_runs w ON w.project_id = e.project_id AND w.execution_id = e.id
  LEFT JOIN agent_runs a ON a.project_id = e.project_id AND a.execution_id = e.id
)
UPDATE executions e SET requester_group_ids = a.groups
FROM attribution a WHERE a.project_id = e.project_id AND a.id = e.id;

ALTER TABLE workflow_runs DROP COLUMN requester_group_ids;
ALTER TABLE agent_runs DROP COLUMN requester_group_ids;
