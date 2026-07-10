import { rest } from "@sixb/connector-rest"
import type { ConnectorAdapter } from "@sixb/core"
import { createPennylaneClient } from "./client"
import { createPennylaneHttp } from "./http"
import type {
  PennylaneAccessTokenResolver,
  PennylaneClient,
  PennylaneConnectorOptions,
} from "./types"

const DEFAULT_BASE_URL = "https://app.pennylane.com/api/external/v2/"
const DEFAULT_MIN_DELAY_MS = 200

export type PennylaneConnector = ConnectorAdapter<"pennylane", PennylaneClient>

export function pennylane(options: PennylaneConnectorOptions): PennylaneConnector {
  assertTokenResolver(options.accessToken)

  const restAdapter = rest({
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    headers: async () => ({
      Authorization: `Bearer ${await resolveToken(options.accessToken)}`,
      Accept: "application/json",
    }),
    timeoutMs: options.timeoutMs,
    // Retries are method-aware in the Pennylane HTTP layer.
    retry: { maxRetries: 0 },
  })

  return {
    type: "pennylane",
    async connect(context) {
      const restClient = await restAdapter.connect(context)
      return createPennylaneClient(
        createPennylaneHttp(restClient, {
          minDelayMs: options.minDelayMs ?? DEFAULT_MIN_DELAY_MS,
          retry: options.retry,
          signal: context.signal,
        })
      )
    },
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function assertTokenResolver(token: PennylaneAccessTokenResolver): void {
  if (typeof token === "string" && !token.trim()) {
    throw new Error("[SixbPennylane] accessToken must not be empty.")
  }
  if (typeof token !== "string" && typeof token !== "function") {
    throw new Error("[SixbPennylane] accessToken must be a string or a function.")
  }
}

async function resolveToken(token: PennylaneAccessTokenResolver): Promise<string> {
  const value = typeof token === "function" ? await token() : token
  if (!value.trim()) {
    throw new Error("[SixbPennylane] accessToken must not be empty.")
  }

  return value
}
