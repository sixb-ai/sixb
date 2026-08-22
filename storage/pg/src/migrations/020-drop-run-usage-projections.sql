ALTER TABLE agent_runs
  DROP COLUMN usage_input_tokens,
  DROP COLUMN usage_output_tokens,
  DROP COLUMN usage_total_tokens,
  DROP COLUMN usage_reasoning_tokens,
  DROP COLUMN usage_cached_input_tokens;

ALTER TABLE workflow_agent_node_runs DROP COLUMN usage;
