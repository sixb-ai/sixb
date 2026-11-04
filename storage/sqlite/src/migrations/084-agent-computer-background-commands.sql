-- What each open sixb reports of its threads' background commands, which outlive the turn that
-- started them, and the ones someone asked to stop from the web: its renewals hand those back.
ALTER TABLE agent_computer_sessions ADD COLUMN background_commands TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_computer_sessions ADD COLUMN stop_requests TEXT NOT NULL DEFAULT '[]';
