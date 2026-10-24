-- A paused Agent turn resumes once its requester decided on every call it held. What that needs:
-- the mode "Always allow" raised the turn to, whether the turn may still resume on a call, and the
-- claim a process takes before it runs an approved call left without its outcome.
ALTER TABLE agent_approvals
  ADD COLUMN raised_mode TEXT CHECK (raised_mode IN ('manual', 'accept-edits', 'auto'));
ALTER TABLE agent_approvals ADD COLUMN turn_stopped_at TEXT;
ALTER TABLE agent_approvals ADD COLUMN execution_claimed_at TEXT;

-- The repair pass: calls past their time, approved calls without an outcome, and decided calls of
-- turns that may still resume. Each index covers only the rows that are still work.
CREATE INDEX idx_agent_approvals_due
  ON agent_approvals (project_id, expires_at)
  WHERE status = 'pending';
CREATE INDEX idx_agent_approvals_unfinished
  ON agent_approvals (project_id, created_at, id)
  WHERE status = 'approved' AND outcome IS NULL;
CREATE INDEX idx_agent_approvals_resumable
  ON agent_approvals (project_id, created_at, id)
  WHERE status IN ('approved', 'denied') AND reported_in_message_id IS NULL
    AND turn_stopped_at IS NULL;
