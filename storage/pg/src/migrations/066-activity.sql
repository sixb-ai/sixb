-- App activity: one source per verified session, the visits it opened, and their page views.
-- Foreground activity moves a visit's `last_seen_at` and stores no row, unless it opens a visit.
-- A session id names an `auth_sessions` row for a user and a `share_sessions` row for a share; it
-- is not a secret, and no foreign key holds it, so history outlives its sessions. Ids compare
-- byte by byte, as the other providers sort them.
CREATE TABLE activity_sources (
  project_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'share')),
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  visit_id TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  window_start TIMESTAMPTZ NOT NULL,
  window_count INTEGER NOT NULL CHECK (window_count >= 0),
  PRIMARY KEY (project_id, actor_type, session_id)
);

CREATE TABLE activity_visits (
  project_id TEXT NOT NULL,
  id TEXT COLLATE "C" NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'share')),
  user_id TEXT COLLATE "C",
  grant_id TEXT,
  session_id TEXT NOT NULL CHECK (length(session_id) > 0),
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL CHECK (last_seen_at >= started_at),
  page_views INTEGER NOT NULL CHECK (page_views >= 0),
  attribution JSONB CHECK (attribution IS NULL OR jsonb_typeof(attribution) = 'object'),
  PRIMARY KEY (project_id, id),
  CHECK (
    (actor_type = 'user' AND user_id IS NOT NULL AND grant_id IS NULL)
    OR (actor_type = 'share' AND user_id IS NULL AND grant_id IS NOT NULL)
  )
);

-- A period reads the visits it overlaps. A visit lasts less than a day, so they started in
-- `[from - 1 day, to)`: both period indexes bound `started_at` on both sides. `last_seen_at` is
-- left out of every index, so the update each batch makes touches none of them. The user index
-- also serves deleting one user's history.
CREATE INDEX idx_activity_visits_started
  ON activity_visits (project_id, started_at, id);
CREATE INDEX idx_activity_visits_user
  ON activity_visits (project_id, user_id, started_at, id);
-- A session's visits, to join them with the session and the executions it authorized.
CREATE INDEX idx_activity_visits_session
  ON activity_visits (project_id, actor_type, session_id);

CREATE TABLE activity_page_views (
  project_id TEXT NOT NULL,
  visit_id TEXT COLLATE "C" NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  id TEXT NOT NULL,
  route TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  attribution JSONB CHECK (attribution IS NULL OR jsonb_typeof(attribution) = 'object'),
  PRIMARY KEY (project_id, visit_id, sequence),
  FOREIGN KEY (project_id, visit_id) REFERENCES activity_visits (project_id, id) ON DELETE CASCADE
);

-- Finds a retried page view by the id its browser chose.
CREATE INDEX idx_activity_page_views_id ON activity_page_views (project_id, id);
