/**
 * Encode a Google AIP-122 resource name while preserving its `/` separators.
 *
 * Analytics APIs use resource names such as `properties/123/dataStreams/456`
 * as a single path binding. `encodeURIComponent` cannot be applied to the
 * whole value because it would turn separators into `%2F`.
 */
export function analyticsResourceName(
  value: string,
  field: string,
  pattern: RegExp,
  example: string
): string {
  if (!pattern.test(value)) {
    throw new Error(`[SixbGoogle] ${field} must match ${example}.`)
  }
  return value.split("/").map(encodeURIComponent).join("/")
}

export function accountName(value: string, field = "account"): string {
  return analyticsResourceName(value, field, /^accounts\/[^/]+$/, '"accounts/{accountId}"')
}

export function propertyName(value: string, field = "property"): string {
  return analyticsResourceName(value, field, /^properties\/[^/]+$/, '"properties/{propertyId}"')
}

export function childResourceName(value: string, collection: string, field = "name"): string {
  const escaped = collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return analyticsResourceName(
    value,
    field,
    new RegExp(`^properties/[^/]+/${escaped}/[^/]+$`),
    `"properties/{propertyId}/${collection}/{resourceId}"`
  )
}

export function dataStreamName(value: string, field = "dataStream"): string {
  return childResourceName(value, "dataStreams", field)
}

export function measurementProtocolSecretName(value: string, field = "name"): string {
  return analyticsResourceName(
    value,
    field,
    /^properties\/[^/]+\/dataStreams\/[^/]+\/measurementProtocolSecrets\/[^/]+$/,
    '"properties/{propertyId}/dataStreams/{streamId}/measurementProtocolSecrets/{secretId}"'
  )
}
