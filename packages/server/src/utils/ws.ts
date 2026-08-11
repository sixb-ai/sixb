import type { OntologySource } from "@sixb/core"
import type { ExecutionSixb } from "@sixb/core/internal/request-execution"

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

/** The execution SDK attached once when the WebSocket request crosses the auth boundary. */
export function wsRequestSdk(ws: object): ExecutionSixb<readonly OntologySource[]> | null {
  const data = (
    ws as {
      data?: { sdk?: ExecutionSixb<readonly OntologySource[]> | null }
    }
  ).data
  return data?.sdk ?? null
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
