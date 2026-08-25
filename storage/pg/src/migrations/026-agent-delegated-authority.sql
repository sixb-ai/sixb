-- An Agent execution may act under its own managed service account or, when a framework-managed
-- main agent runs on someone's behalf, under that requester's own identity. The previous rule
-- admitted only the service-account form.
--
-- The executor-authority constraint was declared inline and therefore carries a generated name, so
-- it is located by its definition rather than guessed. The new rule is strictly wider, so every
-- existing row still satisfies it and no backfill is required.
DO $$
DECLARE
  target_constraint TEXT;
BEGIN
  SELECT conname
    INTO target_constraint
    FROM pg_constraint
   WHERE conrelid = 'executions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%executor_kind = ''agent''%';

  IF target_constraint IS NULL THEN
    RAISE EXCEPTION 'executions executor-authority constraint not found';
  END IF;

  EXECUTE format('ALTER TABLE executions DROP CONSTRAINT %I', target_constraint);
END $$;

ALTER TABLE executions
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
          authority_kind = 'disabled'
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
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND (
        authority_service_account_id IS NOT NULL
        OR (
          authority_user_id IS NOT NULL
          AND authority_user_id IS NOT DISTINCT FROM requested_by_user_id
        )
      )
    )
    OR (
      executor_kind = 'kernel'
      AND authority_kind = 'kernel'
    )
  );
