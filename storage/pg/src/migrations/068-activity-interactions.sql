-- Interactions an app marks, such as a button: their name and route, never a value. They share
-- the visit's sequence with its page views, so a visit reads both in the order they happened, and
-- cascade with the visit, which counts them as it counts its page views.
ALTER TABLE activity_visits
  ADD COLUMN interactions INTEGER NOT NULL DEFAULT 0 CHECK (interactions >= 0);

CREATE TABLE activity_interactions (
  project_id TEXT NOT NULL,
  visit_id TEXT COLLATE "C" NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  route TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, visit_id, sequence),
  FOREIGN KEY (project_id, visit_id) REFERENCES activity_visits (project_id, id) ON DELETE CASCADE
);

-- Finds a retried interaction by the id its browser chose.
CREATE INDEX idx_activity_interactions_id ON activity_interactions (project_id, id);
