-- The Agent delivers files by publishing artifacts, so a run no longer collects an output
-- directory or reports on it. Stored `output_*` diagnostics go; a run left with none stores none.
UPDATE agent_runs
SET diagnostics = (
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE json_group_array(json(value)) END
  FROM (
    SELECT value
    FROM json_each(agent_runs.diagnostics)
    WHERE json_extract(value, '$.code') NOT LIKE 'output\_%' ESCAPE '\'
    ORDER BY key
  )
)
WHERE diagnostics IS NOT NULL
  AND json_valid(diagnostics)
  AND EXISTS (
    SELECT 1
    FROM json_each(agent_runs.diagnostics)
    WHERE json_extract(value, '$.code') LIKE 'output\_%' ESCAPE '\'
  );
