ALTER TABLE workflow_runs ADD COLUMN output JSONB;

UPDATE workflow_runs AS run
SET output = CASE
  WHEN EXISTS (
    SELECT 1
    FROM workflow_node_runs AS node
    WHERE node.project_id = run.project_id
      AND node.workflow_run_id = run.id
      AND node.status = 'succeeded'
      AND node.node_type <> 'action'
  ) THEN COALESCE(
    (
      SELECT node.output
      FROM workflow_node_runs AS node
      WHERE node.project_id = run.project_id
        AND node.workflow_run_id = run.id
        AND node.status = 'succeeded'
        AND node.node_type <> 'action'
      ORDER BY node.node_index DESC, node.id DESC
      LIMIT 1
    ),
    '{}'::jsonb
  )
  ELSE run.input
END
WHERE run.status = 'succeeded';
