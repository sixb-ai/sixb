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
