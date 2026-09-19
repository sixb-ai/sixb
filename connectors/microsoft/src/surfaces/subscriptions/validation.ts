import { MicrosoftConfigurationError } from "../../errors"
import { isRecord } from "../../guards"
import type { SubscriptionCreate, SubscriptionUpdate } from "../../types/subscriptions"
import { nonEmpty } from "../../validation"

function fields(
  input: unknown,
  allowed: readonly string[]
): asserts input is Record<string, unknown> {
  if (!isRecord(input) || Object.keys(input).some((key) => !allowed.includes(key)))
    throw new MicrosoftConfigurationError("Unsupported subscription input fields.")
}

function endpoint(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new MicrosoftConfigurationError(
      "Subscription notification URLs must be absolute HTTPS URLs."
    )
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new MicrosoftConfigurationError(
      "Subscription notification URLs require HTTPS without credentials or fragments."
    )
}

function expiration(value: string): void {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?Z$/.test(value) ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value.slice(0, 10) ||
    timestamp <= Date.now()
  )
    throw new MicrosoftConfigurationError(
      "Subscription expirationDateTime must be a future UTC timestamp."
    )
}

export function validateUpdate(input: SubscriptionUpdate): void {
  fields(input, ["expirationDateTime", "notificationUrl"])
  if (input.expirationDateTime === undefined && input.notificationUrl === undefined)
    throw new MicrosoftConfigurationError(
      "A subscription update requires expirationDateTime or notificationUrl."
    )
  if (input.expirationDateTime !== undefined) expiration(input.expirationDateTime)
  if (input.notificationUrl !== undefined) endpoint(input.notificationUrl)
}

export function validateCreate(input: SubscriptionCreate): void {
  fields(input, [
    "resource",
    "changeType",
    "notificationUrl",
    "expirationDateTime",
    "clientState",
    "lifecycleNotificationUrl",
    "latestSupportedTlsVersion",
    "notificationUrlAppId",
    "includeResourceData",
  ])
  const resource = nonEmpty(input.resource, "subscription resource")
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(resource) || /[\r\n\\#]/.test(resource))
    throw new MicrosoftConfigurationError(
      "Subscription resource must be a relative Microsoft Graph resource path."
    )
  const changes = nonEmpty(input.changeType, "changeType").split(",")
  if (
    changes.some((change) => !["created", "updated", "deleted"].includes(change)) ||
    new Set(changes).size !== changes.length
  )
    throw new MicrosoftConfigurationError(
      "changeType must contain distinct created, updated or deleted values separated by commas."
    )
  endpoint(input.notificationUrl)
  expiration(input.expirationDateTime)
  if (input.lifecycleNotificationUrl !== undefined) endpoint(input.lifecycleNotificationUrl)
  if (
    input.clientState !== undefined &&
    (typeof input.clientState !== "string" || [...input.clientState].length > 128)
  )
    throw new MicrosoftConfigurationError("clientState must be a string of at most 128 characters.")
  if (input.includeResourceData !== undefined && input.includeResourceData !== false)
    throw new MicrosoftConfigurationError(
      "Only basic subscriptions without resource data are supported."
    )
  if (
    input.latestSupportedTlsVersion !== undefined &&
    !["v1_0", "v1_1", "v1_2", "v1_3"].includes(input.latestSupportedTlsVersion)
  )
    throw new MicrosoftConfigurationError("Invalid latestSupportedTlsVersion.")
  if (
    input.notificationUrlAppId !== undefined &&
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.notificationUrlAppId)
  )
    throw new MicrosoftConfigurationError("notificationUrlAppId must be an application UUID.")
}
