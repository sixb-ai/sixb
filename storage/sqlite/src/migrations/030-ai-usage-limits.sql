CREATE TABLE ai_usage_limits (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('project', 'group', 'user', 'serviceAccount')
  ),
  subject_id TEXT NOT NULL CHECK (
    (subject_type = 'project' AND subject_id = '')
    OR (subject_type <> 'project' AND length(trim(subject_id)) > 0)
  ),
  meter TEXT NOT NULL CHECK (meter IN ('tokens.total', 'cost.catalogEstimated')),
  currency TEXT NOT NULL CHECK (
    (meter = 'tokens.total' AND currency = '')
    OR (meter = 'cost.catalogEstimated' AND currency = 'USD')
  ),
  limit_amount TEXT NOT NULL CHECK (
    limit_amount = '0'
    OR (
      limit_amount NOT GLOB '*[^0-9]*'
      AND substr(limit_amount, 1, 1) BETWEEN '1' AND '9'
    )
  ),
  period_kind TEXT NOT NULL CHECK (period_kind = 'calendarMonth'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, subject_type, subject_id, meter, currency)
);

CREATE INDEX idx_ai_usage_limits_project_enabled
  ON ai_usage_limits (project_id, enabled, subject_type, subject_id, meter, currency);

CREATE TABLE ai_usage_limit_periods (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('project', 'group', 'user', 'serviceAccount')
  ),
  subject_id TEXT NOT NULL CHECK (
    (subject_type = 'project' AND subject_id = '')
    OR (subject_type <> 'project' AND length(trim(subject_id)) > 0)
  ),
  meter TEXT NOT NULL CHECK (meter IN ('tokens.total', 'cost.catalogEstimated')),
  currency TEXT NOT NULL CHECK (
    (meter = 'tokens.total' AND currency = '')
    OR (meter = 'cost.catalogEstimated' AND currency = 'USD')
  ),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  actual_amount TEXT NOT NULL DEFAULT '0',
  reserved_amount TEXT NOT NULL DEFAULT '0',
  unknown_amount TEXT NOT NULL DEFAULT '0',
  accounting_status TEXT NOT NULL DEFAULT 'complete' CHECK (
    accounting_status IN ('complete', 'unavailable')
  ),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    project_id, subject_type, subject_id, meter, currency, period_start
  )
);

CREATE INDEX idx_ai_usage_limit_periods_subject_period
  ON ai_usage_limit_periods (
    project_id, subject_type, subject_id, period_start, period_end, meter, currency
  );

CREATE TABLE ai_model_call_reservations (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  call_id TEXT NOT NULL CHECK (length(trim(call_id)) > 0),
  buckets TEXT NOT NULL CHECK (json_valid(buckets) AND json_type(buckets) = 'array'),
  request_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'reconciled', 'unknown')),
  usage_record_id TEXT,
  reserved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, execution_id, attempt, call_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions(project_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id, usage_record_id)
    REFERENCES ai_model_call_usage(project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (
      state = 'reconciled'
      AND usage_record_id IS NOT NULL
    )
    OR (
      state <> 'reconciled'
      AND usage_record_id IS NULL
    )
  )
);

CREATE INDEX idx_ai_model_call_reservations_active
  ON ai_model_call_reservations (project_id, state, period_end, execution_id, attempt, call_id);
