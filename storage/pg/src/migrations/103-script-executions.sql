-- `sixb run` records each script run as an execution: a script executor, the script's path as its
-- source, and authority that holds nothing beyond the run id the executor already names.
ALTER TABLE executions
  DROP CONSTRAINT executions_executor_kind_check,
  ADD CONSTRAINT executions_executor_kind_check CHECK (
    executor_kind IN (
      'request', 'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow',
      'agent', 'kernel', 'script'
    )
  ),
  DROP CONSTRAINT executions_source_kind_check,
  ADD CONSTRAINT executions_source_kind_check CHECK (
    source_kind IN (
      'http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution', 'ontologyCommit',
      'script'
    )
  ),
  DROP CONSTRAINT executions_authority_kind_check,
  ADD CONSTRAINT executions_authority_kind_check CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'delegated', 'kernel', 'script', 'disabled')
  ),
  DROP CONSTRAINT executions_authority_shape_check,
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
      -- A script's authority is its run id, which `executor_id` already holds.
      authority_kind IN ('script', 'disabled')
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
  DROP CONSTRAINT executions_executor_authority_check,
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
      AND source_kind <> 'script'
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
          AND num_nonnulls(authority_session_id, authority_access_token_id) = 1
        )
        OR authority_kind = 'disabled'
      )
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel' AND source_kind <> 'script')
    OR (
      executor_kind = 'script'
      AND source_kind = 'script'
      AND authority_kind = 'script'
      AND requested_by_user_id IS NULL
      AND requested_by_service_account_id IS NULL
    )
  );
