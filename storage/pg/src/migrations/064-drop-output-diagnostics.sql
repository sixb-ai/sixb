-- The Agent delivers files by publishing artifacts, so a run no longer collects an output
-- directory or reports on it. Stored `output_*` diagnostics go; a run left with none stores none.
UPDATE agent_runs
SET diagnostics = (
  SELECT jsonb_agg(item.value ORDER BY item.position)
  FROM jsonb_array_elements(agent_runs.diagnostics) WITH ORDINALITY AS item(value, position)
  WHERE item.value->>'code' NOT LIKE 'output\_%'
)
WHERE jsonb_typeof(diagnostics) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(agent_runs.diagnostics) AS item(value)
    WHERE item.value->>'code' LIKE 'output\_%'
  );
