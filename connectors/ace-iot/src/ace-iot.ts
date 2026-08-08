import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createAceIotClient } from "./client"
import { AceIotConfigurationError } from "./errors"
import { createAceIotHttp } from "./http"
import type { AceIotApiKeyResolver, AceIotClient, AceIotConnectorOptions } from "./types"

const DEFAULT_BASE_URL = "https://flightdeck.aceiot.cloud/api/"

export type AceIotConnector = ConnectorAdapter<"ace-iot", AceIotClient>

export function aceIot(options: AceIotConnectorOptions): AceIotConnector {
  assertApiKeyResolver(options.apiKey)

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      // ACE rejects a bare token: the scheme is required even though its own spec calls this an
      // apiKey header.
      Authorization: `Bearer ${await resolveApiKey(options.apiKey)}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    // Retries are method-aware in the ACE HTTP layer.
    retry: { maxRetries: 0 },
  })

  return {
    type: "ace-iot",
    async connect(context) {
      const restClient = await restAdapter.connect(context)
      return createAceIotClient(
        createAceIotHttp(restClient, {
          minDelayMs: options.minDelayMs,
          retry: options.retry,
          signal: context.signal,
        })
      )
    },
  }
}

/**
 * Every request path is relative, so the base URL has to end in a slash. Without one, `new URL()`
 * drops the last segment and `https://host/api` would resolve `sites/` to `https://host/sites/`.
 */
function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    throw new AceIotConfigurationError("[SixbAceIot] baseUrl must not be empty.")
  }

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function assertApiKeyResolver(apiKey: AceIotApiKeyResolver): void {
  if (typeof apiKey === "string" && !apiKey.trim()) {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must not be empty.")
  }
  if (typeof apiKey !== "string" && typeof apiKey !== "function") {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must be a string or a function.")
  }
}

async function resolveApiKey(apiKey: AceIotApiKeyResolver): Promise<string> {
  const value = typeof apiKey === "function" ? await apiKey() : apiKey
  if (!value.trim()) {
    throw new AceIotConfigurationError("[SixbAceIot] apiKey must not be empty.")
  }

  return value
}
