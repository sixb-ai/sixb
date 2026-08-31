import {
  assertNonEmpty,
  createMetaRetryContext,
  type MetaHttpContext,
  parseMetaBody,
  parseMetaGraphError,
  parseMetaUsage,
  readJson,
} from "../http"
import type {
  MetaBatchApi,
  MetaBatchGetRequest,
  MetaBatchResult,
  MetaBatchResults,
} from "../types/batch"
import type { MetaHeader, MetaRetryContext } from "../types/common"

const MAX_BATCH_SIZE = 50

export function createBatchApi(context: MetaHttpContext): MetaBatchApi {
  return {
    get<TBody = unknown>(
      relativeUrl: string,
      options?: { readonly accessToken?: string }
    ): MetaBatchGetRequest<TBody> {
      assertNonEmpty(relativeUrl, "batch relativeUrl")
      if (options?.accessToken !== undefined) {
        assertNonEmpty(options.accessToken, "batch accessToken")
      }
      return { relativeUrl, accessToken: options?.accessToken }
    },
    execute: <const TRequests extends readonly MetaBatchGetRequest[]>(requests: TRequests) =>
      executeBatch(context, requests),
  }
}

async function executeBatch<const TRequests extends readonly MetaBatchGetRequest[]>(
  context: MetaHttpContext,
  requests: TRequests
): Promise<MetaBatchResults<TRequests>> {
  assertBatchSize(requests.length)
  const prepared = requests.map((request, index) => ({
    index,
    request,
    relativeUrl: prepareRelativeUrl(request),
  }))
  const results: MetaBatchResult[] = new Array(requests.length)
  let pending = prepared
  let attempt = 0

  while (pending.length > 0) {
    const rawResults = await sendBatch(
      context,
      pending.map(({ relativeUrl }) => relativeUrl)
    )
    if (rawResults.length !== pending.length) {
      throw new Error(
        `[SixbMeta] Graph batch returned ${rawResults.length} responses for ${pending.length} requests.`
      )
    }

    const retryable: Array<{
      readonly item: (typeof pending)[number]
      readonly retryContext: MetaRetryContext
    }> = []

    for (const [pendingIndex, item] of pending.entries()) {
      const raw = rawResults[pendingIndex]
      if (!raw) {
        throw new Error(`[SixbMeta] Graph batch response ${pendingIndex} is missing.`)
      }
      const result = readBatchResult(raw)
      await context.observe.observeBatch(
        item.request.relativeUrl,
        result.status,
        result.headers,
        item.index
      )

      if (!result.ok && attempt < context.retry.maxRetries) {
        const retryContext = await createMetaRetryContext(
          batchResultResponse(result),
          null,
          attempt,
          {
            path: item.request.relativeUrl,
            method: "GET",
            batchIndex: item.index,
          }
        )
        if (await context.retry.shouldRetry(retryContext)) {
          retryable.push({ item, retryContext })
          continue
        }
      }

      results[item.index] = result
    }

    if (retryable.length === 0) break

    const delays = await Promise.all(
      retryable.map(({ retryContext }) => context.retry.delayMs(retryContext))
    )
    await sleep(Math.max(0, ...delays), context.signal)
    pending = retryable.map(({ item }) => item)
    attempt += 1
  }

  return results as MetaBatchResults<TRequests>
}

async function sendBatch(
  context: MetaHttpContext,
  relativeUrls: readonly string[]
): Promise<readonly RawBatchResult[]> {
  const batch = relativeUrls.map((relativeUrl) => ({
    method: "GET",
    relative_url: relativeUrl,
  }))
  const body = new URLSearchParams({ batch: JSON.stringify(batch) })
  const response = await context.http.post("", body, undefined, { idempotent: true })
  const parsed = await readJson<unknown>(response)
  if (!Array.isArray(parsed)) {
    throw new Error("[SixbMeta] Graph batch response must be an array.")
  }
  return parsed as readonly RawBatchResult[]
}

function readBatchResult(raw: RawBatchResult): MetaBatchResult {
  if (!Number.isInteger(raw.code) || raw.code < 100 || raw.code > 599) {
    throw new Error("[SixbMeta] Graph batch response is missing a valid status code.")
  }
  const status = raw.code
  const rawBody = typeof raw.body === "string" ? raw.body : ""
  const body = parseMetaBody(rawBody)
  const headers = readBatchHeaders(raw.headers)
  const usage = parseMetaUsage(headers)

  return status >= 200 && status < 300
    ? { ok: true, status, body, rawBody, headers, usage }
    : {
        ok: false,
        status,
        body,
        rawBody,
        headers,
        usage,
        error: parseMetaGraphError(body),
      }
}

function readBatchHeaders(value: unknown): readonly MetaHeader[] {
  if (!Array.isArray(value)) return []
  const headers: MetaHeader[] = []
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      "value" in entry &&
      typeof entry.name === "string" &&
      typeof entry.value === "string"
    ) {
      headers.push({ name: entry.name, value: entry.value })
    }
  }
  return headers
}

function batchResultResponse(result: MetaBatchResult): Response {
  const headers = new Headers()
  for (const { name, value } of result.headers) {
    headers.append(name, value)
  }
  return new Response(result.rawBody || null, { status: result.status, headers })
}

function prepareRelativeUrl(request: MetaBatchGetRequest): string {
  const relativeUrl = request.relativeUrl.trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(relativeUrl) || relativeUrl.startsWith("//")) {
    throw new Error("[SixbMeta] batch relativeUrl must not be absolute.")
  }
  if (relativeUrl.includes("#")) {
    throw new Error("[SixbMeta] batch relativeUrl must not contain a fragment.")
  }

  const normalized = relativeUrl.replace(/^\/+/, "")
  if (!request.accessToken) return normalized

  const url = new URL(normalized, "https://graph.facebook.com/")
  url.searchParams.set("access_token", request.accessToken)
  return `${url.pathname.slice(1)}${url.search}`
}

function assertBatchSize(size: number): void {
  if (size < 1 || size > MAX_BATCH_SIZE) {
    throw new Error(`[SixbMeta] Graph batch must contain between 1 and ${MAX_BATCH_SIZE} requests.`)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  if (ms <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

interface RawBatchResult {
  readonly code: number
  readonly headers?: unknown
  readonly body?: string
}
