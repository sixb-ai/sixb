-- A child that pauses on its question waits for a later turn of its parent's conversation to
-- answer it. Each turn reads which of the conversation's children wait so: few do, so a partial
-- index keeps that read small however many children the conversation had.
CREATE INDEX idx_agent_runs_paused_on_question
  ON agent_runs (project_id, parent_run_id)
  WHERE kind = 'subagent' AND finish_reason = 'awaiting_answer';
