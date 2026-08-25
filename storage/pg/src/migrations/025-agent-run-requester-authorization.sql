ALTER TABLE agent_runs
  ADD COLUMN requester_authorization_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_requester_authorization_group_ids_array
  CHECK (jsonb_typeof(requester_authorization_group_ids) = 'array');
