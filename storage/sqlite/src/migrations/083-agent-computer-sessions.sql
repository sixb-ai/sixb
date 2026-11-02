-- Where a computer's thread runs: the computer's name and the folder there, beside its id. A
-- computer kept before folders were has none until its owner moves the thread.
ALTER TABLE agent_threads ADD COLUMN computer_name TEXT;
ALTER TABLE agent_threads ADD COLUMN computer_folder TEXT;
UPDATE agent_threads SET computer_id = NULL WHERE computer_id IS NOT NULL;
-- When its turns last moved to where they run now: the files earlier turns used are not there.
ALTER TABLE agent_threads ADD COLUMN moved_at TEXT;

-- Each open sixb on its owner's computers, a lease it renews: while one is live, the threads that
-- run on its computer in its folder are reachable there.
CREATE TABLE agent_computer_sessions (
  project_id TEXT NOT NULL,
  owner_principal_type TEXT NOT NULL CHECK (owner_principal_type IN ('user', 'serviceAccount', 'system')),
  owner_principal_id TEXT NOT NULL CHECK (length(owner_principal_id) > 0),
  id TEXT NOT NULL CHECK (length(id) > 0),
  computer_id TEXT NOT NULL,
  computer_name TEXT NOT NULL,
  folder TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, owner_principal_type, owner_principal_id, id)
);
CREATE INDEX agent_computer_sessions_by_expiry ON agent_computer_sessions (project_id, expires_at);

-- Each open sixb asks every 20 seconds which of its owner's threads here have a turn active.
CREATE INDEX agent_threads_active_on_computer
  ON agent_threads (project_id, owner_principal_type, owner_principal_id, computer_id, computer_folder)
  WHERE active_run_id IS NOT NULL;
