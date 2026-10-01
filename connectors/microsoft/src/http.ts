import { type RestClient, type RestRequestInit, readResponseBody } from "@sixb/connector-rest"
import { MicrosoftApiError, MicrosoftProtocolError } from "./errors"
import { graphUrl, httpsUrl } from "./validation"

export interface GraphRequestOptions {
  /** A Graph action that changes nothing (such as preview) may be replayed like a read. */
  readonly replayable?: boolean
}

export interface MicrosoftHttp {
  readonly signal: AbortSignal
  request(path: string, init?: RestRequestInit, options?: GraphRequestOptions): Promise<Response>
  json(path: string, init?: RestRequestInit, options?: GraphRequestOptions): Promise<unknown>
  media(url: string, init?: RestRequestInit): Promise<Response>
}

export function createMicrosoftHttp(
  graph: RestClient,
  media: RestClient,
  signal: AbortSignal
): MicrosoftHttp {
  const request = (path: string, init: RestRequestInit = {}, options?: GraphRequestOptions) => {
    const replayable = options?.replayable ?? (init.method ?? "GET") === "GET"
    return graph.request(
      graphUrl(path),
      { ...init, redirect: "manual" },
      { idempotent: replayable, retryable: replayable }
    )
  }
  return {
    signal,
    request,
    async json(path, init, options) {
      return readJson(await request(path, init, options))
    },
    async media(url, init = {}) {
      // These are preauthenticated URLs returned by Graph, not Graph API endpoints.
      // No bearer headers, no cookie credentials and no implicit redirect of upload bodies.
      const response = await media.request(
        httpsUrl(url).href,
        {
          ...init,
          credentials: "omit",
          redirect: "manual",
        },
        {
          idempotent: (init.method ?? "GET") === "GET",
          retryable: (init.method ?? "GET") === "GET",
        }
      )
      return response
    },
  }
}

export async function readJson(response: Response): Promise<unknown> {
  const body = await readResponseBody(response)
  if (!response.ok) throw new MicrosoftApiError(response, body)
  if (body === undefined || typeof body !== "object" || body === null) {
    throw new MicrosoftProtocolError("Expected a JSON response from Microsoft Graph.")
  }
  return body
}

export async function checkEmpty(response: Response): Promise<void> {
  if (!response.ok) throw new MicrosoftApiError(response, await readResponseBody(response))
  await response.body?.cancel()
}
