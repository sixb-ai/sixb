import type { AuthorizationContext } from "@sixb/core"

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
