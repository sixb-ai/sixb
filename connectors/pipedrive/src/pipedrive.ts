import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createPipedriveClient } from "./client"
import { createPipedriveHttp } from "./http"
import type { PipedriveClient, PipedriveConnectorOptions, PipedriveTokenResolver } from "./types"
import { pipedriveEventsWebhook } from "./webhooks"

const DEFAULT_V2_BASE_URL = "https://api.pipedrive.com/api/v2/"
const DEFAULT_V1_BASE_URL = "https://api.pipedrive.com/v1/"

export type PipedriveConnector = ConnectorAdapter<"pipedrive", PipedriveClient>

export function pipedrive(options: PipedriveConnectorOptions): PipedriveConnector {
  assertTokenResolver(options.apiToken)

  const commonRestOptions = {
    headers: async () => ({
      "x-api-token": await resolveToken(options.apiToken),
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: options.retry ?? { maxRetries: 2 },
  }

  const v1 = rest({
    ...commonRestOptions,
    baseUrl: normalizeBaseUrl(options.v1BaseUrl ?? DEFAULT_V1_BASE_URL),
  })
  const v2 = rest({
    ...commonRestOptions,
    baseUrl: normalizeBaseUrl(options.v2BaseUrl ?? DEFAULT_V2_BASE_URL),
  })

  return {
    type: "pipedrive",
    webhooks: options.onEvent
      ? [pipedriveEventsWebhook({ auth: options.webhookAuth, onEvent: options.onEvent })]
      : undefined,
    async connect(context) {
      const [v1Client, v2Client] = await Promise.all([v1.connect(context), v2.connect(context)])
      return createPipedriveClient(createPipedriveHttp({ v1: v1Client, v2: v2Client }))
    },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertTokenResolver(token: PipedriveTokenResolver): void {
  if (typeof token === "string" && !token.trim()) {
    throw new Error("[SixbPipedrive] apiToken must not be empty.")
  }

  if (typeof token !== "string" && typeof token !== "function") {
    throw new Error("[SixbPipedrive] apiToken must be a string or a function.")
  }
}

async function resolveToken(token: PipedriveTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  if (!value.trim()) {
    throw new Error("[SixbPipedrive] apiToken must not be empty.")
  }

  return value
}
