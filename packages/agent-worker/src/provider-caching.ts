import type { AgentDefinition } from "@sixb/core"

type ProviderOptions = AgentDefinition["providerOptions"]

const GATEWAY_PROVIDER_IDS = new Set(["gateway", "gateway.language-model"])

/**
 * Enable the Gateway's provider-neutral automatic caching without leaking provider policy into
 * project Agent definitions. Explicit project configuration always wins.
 */
export function withAutomaticPromptCaching(
  model: AgentDefinition["model"],
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
