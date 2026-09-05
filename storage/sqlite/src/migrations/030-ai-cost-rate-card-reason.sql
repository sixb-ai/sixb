CREATE TABLE ai_model_call_valuations_next (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  usage_record_id TEXT NOT NULL CHECK (length(trim(usage_record_id)) > 0),
  status TEXT NOT NULL CHECK (status IN ('rated', 'unpriceable')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(trim(provider_id)) > 0),
  model_id TEXT CHECK (model_id IS NULL OR length(trim(model_id)) > 0),
  currency TEXT CHECK (
    currency IS NULL OR (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')
  ),
  amount_nanos INTEGER CHECK (
    amount_nanos IS NULL OR (typeof(amount_nanos) = 'integer' AND amount_nanos >= 0)
  ),
  reason TEXT CHECK (
    reason IS NULL OR reason IN (
      'missingBillingIdentity',
      'missingRateCard',
      'missingUsageMeter',
      'unsupportedPricingDimension',
      'invalidUsageForFormula'
    )
  ),
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  rated_at TEXT NOT NULL CHECK (length(trim(rated_at)) > 0),
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

INSERT INTO ai_model_call_valuations_next (
  project_id, usage_record_id, status, provider_id, model_id,
  currency, amount_nanos, reason, details, rated_at
)
SELECT project_id, usage_record_id, status, provider_id, model_id,
  currency, amount_nanos,
  CASE WHEN reason = 'missingCatalogEntry' THEN 'missingRateCard' ELSE reason END,
  details, rated_at
FROM ai_model_call_valuations;

DROP TABLE ai_model_call_valuations;
ALTER TABLE ai_model_call_valuations_next RENAME TO ai_model_call_valuations;

CREATE INDEX idx_ai_model_call_valuations_summary
  ON ai_model_call_valuations (project_id, status, currency, usage_record_id);
