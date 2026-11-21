import { ModelProviderError } from "../models/errors"
import { type BackoffPolicy, backoffDelay } from "../shared/backoff"

/**
 * How a step asks again an interrupted call (see {@link modelCallInterrupted}): at most `retries` more
 * calls, each after a wait that doubles from `initialMs`, at most 15 seconds of waiting in all.
 */
export const MODEL_CALL_RETRY: BackoffPolicy & { readonly retries: number } = {
  retries: 4,
  initialMs: 1_000,
  maxMs: 8_000,
}

// What Bun's fetch (on the error) and Node's (on its `cause`) say when a connection fails: refused,
// reset or closed before its response ended, timed out, or its host briefly unreachable.
const CONNECTION_LOST_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ConnectionRefused",
  "ConnectionClosed",
  "FailedToOpenSocket",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

/**
 * The code of the connection a model call lost, such as `ECONNRESET`, or undefined when the call
 * failed otherwise. A lost connection is not a provider's answer: whether the call was billed is
 * unknown, and the same request may well succeed a moment later.
 */
export function lostConnectionCode(error: unknown): string | undefined {
  const code = errorCode(error) ?? (error instanceof TypeError ? errorCode(error.cause) : undefined)
  return code !== undefined && CONNECTION_LOST_CODES.has(code) ? code : undefined
}

/**
 * Whether a model call broke off for a reason that has nothing to do with its request, so the same
 * request may succeed when it is made again: its connection was lost, or its provider interrupted
 * the response it had started (an error event saying it was overloaded, rate limited or failing,
 * or a stream closed before its end, as the protocols mark them). A refusal before the response,
 * which the binding already retried, is not one.
 */
export function modelCallInterrupted(error: unknown): boolean {
  if (lostConnectionCode(error) !== undefined) return true
  return error instanceof ModelProviderError && error.reason === "interrupted"
}

/**
 * How long the step waits before retry `retry`, counted from 0: between half and all of the
 * policy's delay, so the calls a dropped connection failed together do not come back together.
 */
export function modelCallRetryDelay(retry: number): number {
  const ceiling = backoffDelay(retry, MODEL_CALL_RETRY)
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code: unknown = Reflect.get(error, "code")
  return typeof code === "string" ? code : undefined
}
