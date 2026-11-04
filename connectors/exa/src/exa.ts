import { type RestConnector, rest } from "@sixb/connector-rest"
import { assertApiKeyResolver, createExaClient } from "./client"
import type { ExaConnector, ExaConnectorOptions } from "./types"

const DEFAULT_BASE_URL = "https://api.exa.ai/"

/** Create a typed Exa connector backed by one-attempt REST requests. */
export function exa(options: ExaConnectorOptions): ExaConnector {
  const http = exaRest(options)

  return {
    type: "exa",
    async connect(context) {
      return createExaClient(await http.connect(context), options.apiKey, context.signal)
    },
  }
}

/** Check the options, and return the REST connector that reaches Exa. */
export function exaRest(options: ExaConnectorOptions): RestConnector {
  if (!options || typeof options !== "object") {
    throw new Error("[SixbExa] options must be an object.")
  }
  assertApiKeyResolver(options.apiKey)

  return rest({ baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL) })
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[SixbExa] baseUrl must be an absolute HTTP(S) URL.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("[SixbExa] baseUrl must be an absolute HTTP(S) URL.")
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.toString()
}
