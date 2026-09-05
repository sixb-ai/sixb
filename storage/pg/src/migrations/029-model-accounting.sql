-- Call-time model configuration and provider identity. Historical identity remains unknown.
ALTER TABLE ai_model_call_usage
  ADD COLUMN requested_reasoning JSONB
  CHECK (
    requested_reasoning IS NULL OR
    jsonb_typeof(requested_reasoning) IN ('string', 'object')
  );
ALTER TABLE ai_model_call_usage ADD COLUMN provider_ids JSONB;

-- Upgrade the shipped valuation reason while retaining the selected-cost projection.
ALTER TABLE ai_model_call_valuations
  DROP CONSTRAINT ai_model_call_valuations_reason_check;

UPDATE ai_model_call_valuations SET reason = 'missingRateCard'
  WHERE reason = 'missingCatalogEntry';

ALTER TABLE ai_model_call_valuations ADD CONSTRAINT ai_model_call_valuations_reason_check
  CHECK (reason IS NULL OR reason IN (
    'missingBillingIdentity',
    'missingRateCard',
    'missingUsageMeter',
    'unsupportedPricingDimension',
    'invalidUsageForFormula'
  ));
