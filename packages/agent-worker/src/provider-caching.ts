import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider"

type ProviderOptions = LanguageModelV4CallOptions["providerOptions"]

const GATEWAY_PROVIDER_IDS = new Set(["gateway", "gateway.language-model"])

/**
 * Enable the Gateway's provider-neutral automatic caching without leaking provider policy into
 * the public Agent configuration. Explicit provider options always win.
 */
export function withAutomaticPromptCaching(
  model: LanguageModelV4,
  providerOptions: ProviderOptions
): ProviderOptions {
  if (!GATEWAY_PROVIDER_IDS.has(model.provider)) return providerOptions

  const gateway = providerOptions?.gateway
  if (gateway !== undefined && !isJsonObject(gateway)) return providerOptions
  if (gateway !== undefined && Object.hasOwn(gateway, "caching")) return providerOptions

  return {
    ...providerOptions,
    gateway: {
      ...gateway,
      caching: "auto",
    },
  }
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
