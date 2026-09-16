import { type RestRequestContext, rest } from "@sixb/connector-rest"
import type { ConnectorAccessToken, ConnectorContext, ConnectorTokenSource } from "@sixb/core"
import { QuickBooksApiError } from "./errors"
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

  return {
    async get(path: string): Promise<unknown> {
      const response = await client.get(
        `${path}${path.includes("?") ? "&" : "?"}minorversion=${options.minorVersion ?? 75}`
      )
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new QuickBooksApiError(response.status, response.headers.get("intuit_tid"), [])
      }
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
          typeof fault?.type === "string" ? fault.type : undefined
        )
      }
      return body
    },
  }
}
