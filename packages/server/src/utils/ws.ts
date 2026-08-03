import type { AuthorizationContext } from "@sixb/core"
import { type SixbErrorCode, toSixbFailure } from "@sixb/core/errors"

/**
 * How a socket answers a failure: the same `code` + `message` pair the HTTP error body carries.
 *
 * `code` is required, not optional. A socket frame has no OpenAPI schema and no generated reader, so
 * an optional field here would have stayed empty at every send site — and a client that receives only
 * a message is back to matching on text. `broker.cursor_expired` is the case that makes it concrete:
 * a consumer that reads the code resubscribes, a consumer that reads prose guesses.
 */
export interface WsErrorFrame {
  readonly type: "error"
  readonly code: SixbErrorCode
  readonly message: string
}

/** A failure the socket itself decided on: a rejected frame, a missing run, a denied subscription. */
export function wsError(code: SixbErrorCode, message: string): WsErrorFrame {
  return { type: "error", code, message }
}

/**
 * A thrown value, answered under the code it carries.
 *
 * `fallbackCode` is what an unlabeled throw is filed as. Required for the same reason `code` is: the
 * one thing a socket must not do is shrug.
 */
export function wsErrorFrom(error: unknown, fallbackCode: SixbErrorCode): WsErrorFrame {
  const { code, message } = toSixbFailure(error, { fallbackCode })
  return { type: "error", code, message }
}

export function safeSend(target: { send: (message: string) => void }, payload: unknown): void {
  try {
    target.send(JSON.stringify(payload))
  } catch {
    // no-op
  }
}

/** Stable per-connection key for a subscription-state WeakMap (the raw socket when Elysia wraps it). */
export function wsStateKey(ws: object): object {
  const raw = (ws as { raw?: unknown }).raw
  return raw && typeof raw === "object" ? raw : ws
}

/** The authorization context attached to a websocket connection; null when unauthenticated/disabled. */
export function wsAuthz(ws: object): AuthorizationContext | null {
  const data = (ws as { data?: { authz?: AuthorizationContext | null } }).data
  return data?.authz ?? null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function decodeWsMessage(message: unknown): Promise<unknown> {
  if (message && typeof message === "object") {
    if ("data" in message && (message as { data?: unknown }).data !== undefined) {
      return decodeWsMessage((message as { data: unknown }).data)
    }

    if (message instanceof ArrayBuffer) {
      const text = new TextDecoder().decode(new Uint8Array(message))
      return parseJson(text)
    }

    if (ArrayBuffer.isView(message)) {
      const text = new TextDecoder().decode(message)
      return parseJson(text)
    }

    if (typeof Blob !== "undefined" && message instanceof Blob) {
      return parseJson(await message.text())
    }

    return message
  }

  if (typeof message === "string") {
    return parseJson(message)
  }

  return null
}
