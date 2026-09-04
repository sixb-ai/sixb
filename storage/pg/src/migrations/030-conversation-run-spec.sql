ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_kind_fields,
  ADD CONSTRAINT agent_runs_kind_fields CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
      AND result IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND thread_id IS NULL
      AND agent_id IS NULL
      AND trigger_message_id IS NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND spec IS NOT NULL
    )
  );

-- Preserve immutable historical estimates; reported amounts use the same per-call ledger.
ALTER TABLE ai_model_call_valuations
  DROP CONSTRAINT ai_model_call_valuations_status_check,
  DROP CONSTRAINT ai_model_call_valuations_check,
  ADD CONSTRAINT ai_model_call_valuations_status_check
    CHECK (status IN ('reported', 'rated', 'unpriceable')),
  ADD CONSTRAINT ai_model_call_valuations_check CHECK (
    (
      status IN ('reported', 'rated')
      AND provider_id IS NOT NULL
      AND model_id IS NOT NULL
      AND currency IS NOT NULL
      AND amount_nanos IS NOT NULL
      AND reason IS NULL
    )
    OR
    (
      status = 'unpriceable'
      AND currency IS NULL
      AND amount_nanos IS NULL
      AND reason IS NOT NULL
      AND (
        (reason = 'missingBillingIdentity' AND provider_id IS NULL AND model_id IS NULL)
        OR
        (reason <> 'missingBillingIdentity' AND provider_id IS NOT NULL AND model_id IS NOT NULL)
      )
    )
  );
