-- Shared sessions and their execution provenance.
CREATE TABLE share_sessions (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  grant_id TEXT NOT NULL CHECK (length(trim(grant_id)) > 0),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id, grant_id),
  UNIQUE (project_id, token_hash),
  FOREIGN KEY (project_id, grant_id)
    REFERENCES share_grants (project_id, id),
  CHECK (expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (expires_at <= absolute_expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_share_sessions_grant
  ON share_sessions (project_id, grant_id, created_at DESC, id DESC);

CREATE INDEX idx_share_sessions_expiry
  ON share_sessions (project_id, expires_at)
  WHERE revoked_at IS NULL;

-- Persist shared-session provenance on request executions without fabricating a principal.
CREATE TABLE executions_v2 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  executor_kind TEXT NOT NULL CHECK (
    executor_kind IN (
      'request', 'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow',
      'agent', 'kernel'
    )
  ),
  executor_id TEXT NOT NULL CHECK (length(trim(executor_id)) > 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution')
  ),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  requested_by_user_id TEXT,
  requested_by_service_account_id TEXT,
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  parent_execution_id TEXT,
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'delegated', 'kernel', 'disabled')
  ),
  authority_user_id TEXT,
  authority_service_account_id TEXT,
  authority_session_id TEXT,
  authority_access_token_id TEXT,
  authority_primitive_kind TEXT CHECK (
    authority_primitive_kind IS NULL
      OR authority_primitive_kind IN (
        'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow'
      )
  ),
  authority_primitive_id TEXT,
  authority_kernel_operation TEXT CHECK (
    authority_kernel_operation IS NULL OR authority_kernel_operation = 'ontology.recover'
  ),
  authority_delegation_kind TEXT CHECK (
    authority_delegation_kind IS NULL OR authority_delegation_kind = 'share'
  ),
  authority_delegation_id TEXT,
  authority_delegation_session_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_execution_id) REFERENCES executions (project_id, id),
  FOREIGN KEY (project_id, requested_by_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, requested_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, authority_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_session_id) REFERENCES auth_sessions (project_id, id),
  FOREIGN KEY (project_id, authority_access_token_id)
    REFERENCES auth_access_tokens (project_id, id),
  FOREIGN KEY (
    project_id, authority_delegation_session_id, authority_delegation_id
  ) REFERENCES share_sessions (project_id, id, grant_id),
  CHECK ((requested_by_user_id IS NOT NULL) + (requested_by_service_account_id IS NOT NULL) <= 1),
  CHECK (
    (source_kind = 'execution' AND parent_execution_id = source_id)
      OR (source_kind <> 'execution' AND parent_execution_id IS NULL)
  ),
  CHECK (
    (
      authority_kind = 'principal'
      AND (authority_user_id IS NOT NULL) + (authority_service_account_id IS NOT NULL) = 1
      AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) <= 1
      AND (authority_session_id IS NULL OR authority_user_id IS NOT NULL)
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      authority_kind = 'trustedPrimitive'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NOT NULL
      AND authority_primitive_id IS NOT NULL
      AND length(trim(authority_primitive_id)) > 0
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      authority_kind = 'delegated'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NOT NULL
      AND authority_delegation_kind = 'share'
      AND authority_delegation_id IS NOT NULL
      AND length(trim(authority_delegation_id)) > 0
      AND authority_delegation_session_id IS NOT NULL
      AND length(trim(authority_delegation_session_id)) > 0
    )
    OR (
      authority_kind = 'kernel'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NOT NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      authority_kind = 'disabled'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
  ),
  CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS authority_user_id
          AND requested_by_service_account_id IS authority_service_account_id
        )
        OR (
          authority_kind IN ('delegated', 'disabled')
          AND requested_by_user_id IS NULL
          AND requested_by_service_account_id IS NULL
        )
      )
    )
    OR (
      executor_kind IN ('action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow')
      AND authority_kind = 'trustedPrimitive'
      AND executor_kind = authority_primitive_kind
    )
    OR (
      executor_kind = 'agent'
      AND source_kind = 'execution'
      AND (
        (
          authority_kind = 'principal'
          AND authority_service_account_id IS NOT NULL
          AND authority_session_id IS NULL
          AND authority_access_token_id IS NULL
        )
        OR (
          authority_kind = 'principal'
          AND authority_user_id IS NOT NULL
          AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) = 1
        )
        OR authority_kind = 'disabled'
      )
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel')
  )
);

INSERT INTO executions_v2 (
  project_id, id, executor_kind, executor_id, source_kind, source_id,
  requested_by_user_id, requested_by_service_account_id, correlation_id, parent_execution_id,
  authority_kind, authority_user_id, authority_service_account_id, authority_session_id,
  authority_access_token_id, authority_primitive_kind, authority_primitive_id,
  authority_kernel_operation, authority_delegation_kind, authority_delegation_id,
  authority_delegation_session_id, created_at
)
SELECT
  project_id, id, executor_kind, executor_id, source_kind, source_id,
  requested_by_user_id, requested_by_service_account_id, correlation_id, parent_execution_id,
  authority_kind, authority_user_id, authority_service_account_id, authority_session_id,
  authority_access_token_id, authority_primitive_kind, authority_primitive_id,
  authority_kernel_operation, NULL, NULL, NULL, created_at
FROM executions;

DROP TABLE executions;
ALTER TABLE executions_v2 RENAME TO executions;
