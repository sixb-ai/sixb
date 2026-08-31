CREATE TABLE ai_model_call_valuations (
  project_id TEXT NOT NULL CHECK (length(btrim(project_id)) > 0),
  usage_record_id TEXT NOT NULL CHECK (length(btrim(usage_record_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('rated', 'unpriceable')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(btrim(provider_id)) > 0),
  model_id TEXT CHECK (model_id IS NULL OR length(btrim(model_id)) > 0),
  currency TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount_nanos BIGINT CHECK (amount_nanos IS NULL OR amount_nanos >= 0),
  reason TEXT CHECK (
    reason IS NULL OR reason IN (
      'missingBillingIdentity',
      'missingRateCard',
      'missingUsageMeter',
      'unsupportedPricingDimension',
      'invalidUsageForFormula'
    )
  ),
  details JSONB NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  rated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, usage_record_id),
  FOREIGN KEY (project_id, usage_record_id)
    REFERENCES ai_model_call_usage(project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (
      status = 'rated'
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
  )
);

CREATE INDEX idx_ai_model_call_usage_provider_model_time
  ON ai_model_call_usage (project_id, provider_id, requested_model_id, occurred_at, id);
CREATE INDEX idx_ai_model_call_usage_model_time
  ON ai_model_call_usage (project_id, requested_model_id, occurred_at, id);
CREATE INDEX idx_ai_model_call_valuations_summary
  ON ai_model_call_valuations (project_id, status, currency, usage_record_id);
