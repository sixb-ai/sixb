ALTER TABLE executions
  ADD COLUMN authority_delegation_kind TEXT,
  ADD COLUMN authority_delegation_id TEXT,
  ADD COLUMN authority_delegation_session_id TEXT;

-- The original authority checks were unnamed. Drop exactly the checks that mention
-- authority_kind, then replace them with stable names and the delegated variant below.
DO $$
DECLARE authority_constraint RECORD;
BEGIN
  FOR authority_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'executions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%authority_kind%'
  LOOP
    EXECUTE format('ALTER TABLE executions DROP CONSTRAINT %I', authority_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE executions
  ADD CONSTRAINT executions_authority_kind_check CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'delegated', 'kernel', 'disabled')
  ),
  ADD CONSTRAINT executions_authority_delegation_kind_check CHECK (
    authority_delegation_kind IS NULL OR authority_delegation_kind = 'share'
  ),
  ADD CONSTRAINT executions_authority_shape_check CHECK (
    (
      authority_kind = 'principal'
      AND num_nonnulls(authority_user_id, authority_service_account_id) = 1
      AND num_nonnulls(authority_session_id, authority_access_token_id) <= 1
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
  ADD CONSTRAINT executions_executor_authority_check CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS NOT DISTINCT FROM authority_user_id
          AND requested_by_service_account_id IS NOT DISTINCT FROM authority_service_account_id
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
      AND authority_kind = 'principal'
      AND authority_service_account_id IS NOT NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel')
  ),
  ADD CONSTRAINT fk_executions_share_session
    FOREIGN KEY (project_id, authority_delegation_session_id, authority_delegation_id)
    REFERENCES share_sessions (project_id, id, grant_id)
    ON DELETE RESTRICT;
