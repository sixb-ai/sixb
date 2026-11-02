import { AsyncLocalStorage } from "node:async_hooks"
import { runWithStorageTimer, StorageTimer } from "@sixb/core/internal/storage-operation-scope"

const DEFAULT_SLOW_REQUEST_MILLIS = 1_000

export interface SixbRequestTimingOptions {
  /**
   * Send a `Server-Timing` header on responses to signed-in requests, which browsers show under
   * a request's Timing tab. Off by default, since timings reveal how the server spends its time.
   */
  readonly header?: boolean
  /** Log requests that take at least this long. Defaults to 1000; 0 turns the log off. */
  readonly slowRequestMillis?: number
}

/** Read `SIXB_SERVER_TIMING` and `SIXB_SLOW_REQUEST_MS`. */
export function requestTimingOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): SixbRequestTimingOptions {
  const slowRequestMillis = Number(env.SIXB_SLOW_REQUEST_MS)
  return {
    header: env.SIXB_SERVER_TIMING === "1" || env.SIXB_SERVER_TIMING === "true",
    ...(env.SIXB_SLOW_REQUEST_MS && slowRequestMillis >= 0 ? { slowRequestMillis } : {}),
  }
}

class RequestTiming {
  readonly startedAt = performance.now()
  readonly storage = new StorageTimer()
  authorized?: {
    readonly at: number
    readonly storageMillis: number
    readonly storageCalls: number
    readonly route: string
    readonly showTimings: boolean
  }
  subject?: string
}

const currentRequest = new AsyncLocalStorage<RequestTiming>()

/** The request has been authenticated and is about to run its route. */
export function markRequestAuthorized(route: string, showTimings: boolean): void {
  const timing = currentRequest.getStore()
  if (!timing) return
  timing.authorized = {
    at: performance.now(),
    storageMillis: timing.storage.busyMillis,
    storageCalls: timing.storage.calls,
    route,
    showTimings,
  }
}

/** Name what a shared route is working on, so a slow request can be told from its neighbors. */
export function noteRequestSubject(subject: string | undefined): void {
  const timing = currentRequest.getStore()
  if (timing) timing.subject = subject
}

function measure(timing: RequestTiming) {
  const totalMillis = performance.now() - timing.startedAt
  const authMillis = timing.authorized ? timing.authorized.at - timing.startedAt : 0
  const storageMillis = timing.storage.busyMillis - (timing.authorized?.storageMillis ?? 0)
  return {
    totalMillis,
    authMillis,
    storageMillis,
    storageCalls: timing.storage.calls - (timing.authorized?.storageCalls ?? 0),
    // Validating, checking permissions and building the response.
    appMillis: Math.max(0, totalMillis - authMillis - storageMillis),
  }
}

type RequestMeasure = ReturnType<typeof measure>

const storageCalls = (calls: number) => `${calls} ${calls === 1 ? "call" : "calls"}`

function serverTimingHeader(measured: RequestMeasure): string {
  const metric = (name: string, millis: number, description?: string) =>
    `${name};dur=${millis.toFixed(1)}${description ? `;desc="${description}"` : ""}`
  return [
    metric("auth", measured.authMillis),
    metric("storage", measured.storageMillis, storageCalls(measured.storageCalls)),
    metric("app", measured.appMillis),
    metric("total", measured.totalMillis),
  ].join(", ")
}

function logSlowRequest(
  request: Request,
  response: Response,
  timing: RequestTiming,
  measured: RequestMeasure
): void {
  // The route's pattern, not its URL: a path or query string can hold a token or a person's data.
  const route = timing.authorized?.route ?? "(public route)"
  const subject = timing.subject ? ` (${timing.subject})` : ""
  const round = Math.round
  console.warn(
    `[SixbServer] Slow request: ${request.method} ${route}${subject} ${response.status} in ` +
      `${round(measured.totalMillis)} ms: auth ${round(measured.authMillis)}, ` +
      `storage ${round(measured.storageMillis)} in ${storageCalls(measured.storageCalls)}, ` +
      `app ${round(measured.appMillis)}`
  )
}

/** Run one request, then say where its time went. Time after the response starts is not counted. */
export async function timeRequest<TResult>(
  request: Request,
  options: SixbRequestTimingOptions,
  handle: () => TResult | Promise<TResult>
): Promise<TResult | Response> {
  const timing = new RequestTiming()
  const result = await currentRequest.run(timing, () => runWithStorageTimer(timing.storage, handle))
  // A WebSocket upgrade answers with nothing, and lasts as long as the socket.
  if (!(result instanceof Response)) return result

  const measured = measure(timing)
  const slowRequestMillis = options.slowRequestMillis ?? DEFAULT_SLOW_REQUEST_MILLIS
  if (slowRequestMillis > 0 && measured.totalMillis >= slowRequestMillis) {
    logSlowRequest(request, result, timing, measured)
  }
  if (!options.header || !timing.authorized?.showTimings) return result

  const headers = new Headers(result.headers)
  headers.set("server-timing", serverTimingHeader(measured))
  // The app and API are usually on different hosts, and a page only reads timings it is allowed to.
  const origin = request.headers.get("origin")
  if (origin) headers.set("timing-allow-origin", origin)
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  })
}
