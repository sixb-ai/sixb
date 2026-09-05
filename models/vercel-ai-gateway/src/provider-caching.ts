import { isJsonObject, type JsonObject } from "@sixb/core/models"

/**
 * Enable the Gateway's provider-neutral automatic caching without leaking provider policy into
 * project Agent definitions. Explicit project configuration always wins.
 */
export function withAutomaticPromptCaching(
  providerOptions: JsonObject | undefined,
  caching?: "auto" | "off"
): JsonObject | undefined {
  if (caching === "off") return providerOptions
  const gateway = providerOptions?.gateway
  if (gateway !== undefined && !isJsonObject(gateway)) return providerOptions ?? {}
  if (gateway !== undefined && Object.hasOwn(gateway, "caching")) return providerOptions ?? {}

  return {
    ...providerOptions,
    gateway: {
      ...gateway,
      caching: "auto",
    },
  }
}
