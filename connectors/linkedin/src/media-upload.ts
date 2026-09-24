import { rest } from "@sixb/connector-rest"
import type { ConnectorContext, ConnectorTokenSource } from "@sixb/core"

/** Upload failures deliberately exclude signed URLs, response bodies and fetch causes. */
export class LinkedinMediaUploadError extends Error {
  readonly name = "LinkedinMediaUploadError"

  constructor(
    message: string,
    readonly status?: number
  ) {
    super(`[SixbLinkedin] ${message}`)
  }
}

export interface LinkedinMediaTransport {
  readonly signal: AbortSignal
  put(url: string, file: Blob, authenticated: boolean, signal?: AbortSignal): Promise<Headers>
}

export async function createMediaTransport(
  context: ConnectorContext,
  tokenSource: ConnectorTokenSource,
  timeoutMs?: number,
  minDelayMs?: number
): Promise<LinkedinMediaTransport> {
  // No REST API headers or automatic token invalidation on signed upload endpoints.
  const client = await rest({
    baseUrl: "https://www.linkedin.com/",
    timeoutMs,
    minDelayMs,
    retry: { maxRetries: 0 },
  }).connect(context)

  return {
    signal: context.signal,
    async put(url, file, authenticated, signal) {
      assertUploadUrl(url)
      const headers = new Headers({ "Content-Type": "application/octet-stream" })
      if (authenticated) {
        const token = await tokenSource.get()
        if (!token.accessToken.trim()) {
          throw new LinkedinMediaUploadError("Managed OAuth returned an empty access token.")
        }
        headers.set("Authorization", `${token.tokenType ?? "Bearer"} ${token.accessToken}`)
      }
      let response: Response
      try {
        response = await client.request(
          url,
          {
            method: "PUT",
            body: file,
            headers,
            signal,
            redirect: "error",
          },
          { retryable: false }
        )
        if (response.body) await response.body.cancel()
      } catch {
        // Do not retain fetch errors: they may include the signed upload URL.
        throw new LinkedinMediaUploadError(
          "Media transfer failed or was cancelled; it was not retried."
        )
      }
      if (!response.ok) {
        throw new LinkedinMediaUploadError(
          `Media transfer failed with HTTP ${response.status}.`,
          response.status
        )
      }
      return response.headers
    },
  }
}

export function assertUploadUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LinkedinMediaUploadError("LinkedIn returned an invalid upload URL.")
  }
  // The documented upload endpoint is www.linkedin.com; never forward credentials to arbitrary hosts.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.linkedin.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new LinkedinMediaUploadError(
      "Upload URL must use https://www.linkedin.com without credentials, port or fragment."
    )
  }
}
