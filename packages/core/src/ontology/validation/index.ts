export type { BatchValidationResult } from "./batch"
export { validateLinkBatch, validateObjectBatch } from "./batch"
export {
  assertLinkTargetType,
  assertTargetTypeCompatible,
  normalizeLinkProperties,
  validateLinkProperties,
} from "./links"
export {
  coerceSchemaValueToTyped,
  normalizeObjectProperties,
  normalizeSchemaValue,
} from "./normalize"

export {
  assertKnownProperties,
  assertLinkTokenBelongsToObjectType,
  assertObjectTypeRegistered,
  assertPropertyTokenBelongsToObjectType,
  assertRequiredProperties,
  validateObjectProperties,
  validatePrimaryProperties,
  validatePropertyDefinitions,
  validatePropertyValue,
} from "./properties"
export { validateQueryMetadata } from "./query"
export {
  isRecord,
  resolveValueTypeRef,
  resolveValueTypeSchema,
  validateSchemaValue,
} from "./schema"

export {
  assertTelemetryProperty,
  resolveSemanticType,
  validateTelemetryUnit,
} from "./telemetry"
