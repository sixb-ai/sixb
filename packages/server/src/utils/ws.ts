export function safeSend(target: { send: (message: string) => void }, payload: unknown): void {
  try {
    target.send(JSON.stringify(payload))
  } catch {
    // no-op
  }
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
