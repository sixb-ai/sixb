import { rest } from "@sixb/connector-rest"
import { type ConnectorAdapter, resolveWebhookVerification } from "@sixb/core"
import { createPandaDocClient } from "./client"
import { createPandaDocHttp } from "./http"
import type { PandaDocClient, PandaDocConnectorOptions, PandaDocKeyResolver } from "./types"
import { PANDADOC_CONNECTOR_WEBHOOK, pandaDocEventsWebhook } from "./webhooks"

const DEFAULT_BASE_URL = "https://api.pandadoc.com/"

export type PandaDocConnector = ConnectorAdapter<"pandadoc", PandaDocClient>

export function pandadoc(options: PandaDocConnectorOptions): PandaDocConnector {
  assertKeyResolver(options.apiKey, "apiKey")
  assertOptionalKeyResolver(options.webhookSharedKey, "webhookSharedKey")

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: `API-Key ${await resolveKey(options.apiKey, "apiKey")}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: options.retry ?? { maxRetries: 2 },
  })

  return {
    type: "pandadoc",
    webhooks: options.onEvent
      ? [
          pandaDocEventsWebhook(
            {
              ...resolveWebhookVerification(PANDADOC_CONNECTOR_WEBHOOK, {
                credential: options.webhookSharedKey,
                allowUnverified: options.webhookAllowUnverified,
              }),
              onEvent: options.onEvent,
            },
            PANDADOC_CONNECTOR_WEBHOOK
          ),
        ]
      : undefined,
    async connect(context) {
      return createPandaDocClient(createPandaDocHttp(await restAdapter.connect(context)))
    },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertOptionalKeyResolver(
  key: PandaDocKeyResolver | undefined,
  field: string
): asserts key is PandaDocKeyResolver | undefined {
  if (key !== undefined) {
    assertKeyResolver(key, field)
  }
}

function assertKeyResolver(key: PandaDocKeyResolver, field: string): void {
  if (typeof key === "string" && !key.trim()) {
    throw new Error(`[SixbPandaDoc] ${field} must not be empty.`)
  }

  if (typeof key !== "string" && typeof key !== "function") {
    throw new Error(`[SixbPandaDoc] ${field} must be a string or a function.`)
  }
}

async function resolveKey(key: PandaDocKeyResolver, field: string): Promise<string> {
  const value = typeof key === "function" ? await key() : key
  if (!value.trim()) {
    throw new Error(`[SixbPandaDoc] ${field} must not be empty.`)
  }

  return value
}
