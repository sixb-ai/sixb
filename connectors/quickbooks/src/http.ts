import { type RestRequestContext, rest } from "@sixb/connector-rest"
import type { ConnectorAccessToken, ConnectorContext, ConnectorTokenSource } from "@sixb/core"
import { QuickBooksApiError, QuickBooksWriteError } from "./errors"
import type { QuickBooksConnectorOptions, QuickBooksFaultError } from "./types"
import { isRecord, nonEmpty } from "./validation"

export async function createQuickBooksHttp(
  context: ConnectorContext,
  tokens: ConnectorTokenSource,
  options: QuickBooksConnectorOptions,
  companyId: string,
  invalidate: boolean
) {
  const host =
    options.environment === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com"
  const handles = new WeakMap<RestRequestContext, ConnectorAccessToken>()
  const client = await rest({
    baseUrl: `${host}/v3/company/${companyId}/`,
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: { maxRetries: 2, ...options.retry },
    async headers(request) {
      const token = await tokens.get()
      context.signal.throwIfAborted()
      nonEmpty(token.accessToken, "managed access token")
      handles.set(request, token)
      return { Accept: "application/json", Authorization: `Bearer ${token.accessToken}` }
    },
    onUnauthorized: invalidate ? (request) => handles.get(request)?.invalidate() : undefined,
  }).connect(context)

  // Signed attachment URLs must never receive the Accounting API bearer token.
  const downloads = await rest({
    baseUrl: host,
    timeoutMs: options.timeoutMs,
    minDelayMs: options.minDelayMs,
    retry: { maxRetries: 2, ...options.retry },
  }).connect(context)

  const versioned = (path: string) =>
    `${path}${path.includes("?") ? "&" : "?"}minorversion=${options.minorVersion ?? 75}`

  return {
    async download(url: string): Promise<Uint8Array<ArrayBuffer>> {
      const target = new URL(url)
      if (target.protocol !== "https:" || target.username || target.password)
        throw new Error("[SixbQuickBooks] Invalid attachment download URL.")
      const response = await downloads.get(target.href, { redirect: "error", credentials: "omit" })
      if (!response.ok)
        throw new QuickBooksApiError(response.status, response.headers.get("intuit_tid"), [])
      return new Uint8Array(await response.arrayBuffer())
    },
    async upload(body: FormData, requestId: string): Promise<unknown> {
      try {
        const response = await client.post(
          `${versioned("upload")}&requestid=${encodeURIComponent(requestId)}`,
          body,
          undefined,
          { retryable: false }
        )
        const result = await parseResponse(response, requestId)
        // Upload errors can be nested in a successful HTTP response.
        if (isRecord(result) && Array.isArray(result.AttachableResponse))
          for (const item of result.AttachableResponse) throwFault(item, response, requestId)
        return result
      } catch (error) {
        if (error instanceof QuickBooksApiError) throw error
        throw new QuickBooksWriteError(requestId, error)
      }
    },
    async get(path: string): Promise<unknown> {
      return parseResponse(await client.get(versioned(path)))
    },
    async getPdf(path: string): Promise<Uint8Array<ArrayBuffer>> {
      const response = await client.get(versioned(path), {
        headers: { Accept: "application/pdf" },
      })
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
      if (!response.ok || contentType !== "application/pdf") {
        // Preserve provider faults, including faults returned with HTTP 200.
        await parseResponse(response)
        throw new Error("[SixbQuickBooks] Expected an application/pdf response.")
      }
      return new Uint8Array(await response.arrayBuffer())
    },
    async post(path: string, body: unknown, requestId: string, send = false): Promise<unknown> {
      // Reject values JSON would silently turn into null before contacting QuickBooks.
      const payload = send
        ? ""
        : JSON.stringify(body, (_key, value: unknown) => {
            if (typeof value === "number" && !Number.isFinite(value))
              throw new Error("[SixbQuickBooks] Write payload numbers must be finite.")
            return value
          })
      try {
        const response = await client.post(
          `${versioned(path)}&requestid=${encodeURIComponent(requestId)}`,
          payload,
          { headers: { "Content-Type": send ? "application/octet-stream" : "application/json" } },
          { retryable: false }
        )
        return await parseResponse(response, requestId)
      } catch (error) {
        if (error instanceof QuickBooksApiError) throw error
        throw new QuickBooksWriteError(requestId, error)
      }
    },
  }
}

async function parseResponse(response: Response, writeRequestId?: string): Promise<unknown> {
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    if (response.ok && writeRequestId) throw error
    throw new QuickBooksApiError(
      response.status,
      response.headers.get("intuit_tid"),
      [],
      undefined,
      writeRequestId
    )
  }
  throwFault(body, response, writeRequestId)
  return body
}

function throwFault(body: unknown, response: Response, writeRequestId?: string): void {
  if (!response.ok || (isRecord(body) && body.Fault !== undefined)) {
    const fault = isRecord(body) && isRecord(body.Fault) ? body.Fault : undefined
    const errors: QuickBooksFaultError[] = []
    if (Array.isArray(fault?.Error))
      for (const entry of fault.Error) {
        if (isRecord(entry))
          errors.push({
            code: typeof entry.code === "string" ? entry.code : undefined,
            Message: typeof entry.Message === "string" ? entry.Message : undefined,
            Detail: typeof entry.Detail === "string" ? entry.Detail : undefined,
            element: typeof entry.element === "string" ? entry.element : undefined,
          })
      }
    throw new QuickBooksApiError(
      response.status,
      response.headers.get("intuit_tid"),
      errors,
      typeof fault?.type === "string" ? fault.type : undefined,
      writeRequestId
    )
  }
}
