import { TeamleaderApiError } from "./errors"
import type {
  TeamleaderAccessTokenResolver,
  TeamleaderClientOptions,
  TeamleaderRequestOptions,
} from "./types"

const defaultBaseUrl = "https://api.focus.teamleader.eu"

export type TeamleaderRequester = <TResponse>(
  path: string,
  body: unknown,
  options?: TeamleaderRequestOptions
) => Promise<TResponse>

export function createRequester(options: TeamleaderClientOptions): TeamleaderRequester {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const baseUrl = options.baseUrl ?? defaultBaseUrl

  return async function request<TResponse>(
    path: string,
    body: unknown,
    requestOptions: TeamleaderRequestOptions | undefined
  ): Promise<TResponse> {
    if (!fetchImplementation) {
      throw new Error("[SixbTeamleader] fetch is not available.")
    }

    const accessToken = await resolveAccessToken(options.accessToken)
    const response = await fetchImplementation(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: resolveSignal(options.timeoutMs, requestOptions?.signal),
    })

    const responseBody = await readResponseBody(response)
    if (!response.ok) {
      throw new TeamleaderApiError(response.status, extractErrors(responseBody), responseBody)
    }

    return responseBody as TResponse
  }
}

export function assertAccessTokenResolver(accessToken: TeamleaderAccessTokenResolver): void {
  if (typeof accessToken === "string" && !accessToken.trim()) {
    throw new Error("[SixbTeamleader] accessToken must not be empty.")
  }

  if (typeof accessToken !== "string" && typeof accessToken !== "function") {
    throw new Error("[SixbTeamleader] accessToken must be a string or a function.")
  }
}

async function resolveAccessToken(accessToken: TeamleaderAccessTokenResolver): Promise<string> {
  const value = typeof accessToken === "function" ? await accessToken() : accessToken
  if (!value.trim()) {
    throw new Error("[SixbTeamleader] accessToken must not be empty.")
  }

  return value
}

function resolveSignal(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined
): AbortSignal | undefined {
  if (timeoutMs === undefined) {
    return signal
  }

  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }

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

function extractErrors(value: unknown) {
  if (isRecord(value) && Array.isArray(value.errors)) {
    return value.errors.filter(isRecord)
  }

  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
