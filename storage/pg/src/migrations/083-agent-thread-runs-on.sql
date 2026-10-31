-- Where a conversation's turns run: NULL in the cloud, 'computer' on its owner's computer.
ALTER TABLE agent_threads ADD COLUMN runs_on TEXT CHECK (runs_on IS NULL OR runs_on = 'computer');
