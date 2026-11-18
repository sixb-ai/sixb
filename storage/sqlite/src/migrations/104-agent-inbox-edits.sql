-- An edit sent while a turn runs waits here for that turn to end, then rewinds the thread to the
-- message it replaces.
ALTER TABLE agent_thread_inbox ADD COLUMN replaces_message_id TEXT;
