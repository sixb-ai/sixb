ALTER TABLE agent_runs
  ADD COLUMN requester_authorization_group_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(requester_authorization_group_ids)
    AND json_type(requester_authorization_group_ids) = 'array'
  );
