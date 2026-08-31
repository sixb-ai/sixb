import type { RestClient } from "@sixb/connector-rest"
import { GoogleAdsApiError, GoogleAdsProtocolError } from "./errors"

export interface GoogleAdsHttp {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
}

export function createGoogleAdsHttp(client: RestClient, signal: AbortSignal): GoogleAdsHttp {
  return {
    async get<T>(path: string): Promise<T> {
      return readJson<T>(await client.get(path, { signal }))
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return readJson<T>(await client.post(path, body, { signal }))
    },
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await readBody(response)
  if (!response.ok) {
    throw new GoogleAdsApiError(response.status, body, response.headers)
  }
  if (body === undefined || typeof body === "string") {
    throw new GoogleAdsProtocolError(
      "Google Ads API returned a successful response without a valid JSON body.",
      body
    )
  }
  return body as T
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
