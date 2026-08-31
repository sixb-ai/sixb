const MAX_SSE_EVENT_BYTES = 1024 * 1024

export interface ServerSentEvent {
  readonly event?: string
  readonly data: string
}

/** Parse SSE records across arbitrary transport chunk boundaries. */
export async function* decodeServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncIterable<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal.reason)
      const { done, value } = await reader.read()
      if (signal.aborted) throw abortError(signal.reason)
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > MAX_SSE_EVENT_BYTES * 2) {
        throw new Error("[SixbOpenResponses] SSE buffer exceeded the safety limit.")
      }
      let boundary = findBoundary(buffer)
      while (boundary) {
        const record = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        if (record.length > MAX_SSE_EVENT_BYTES) {
          throw new Error("[SixbOpenResponses] SSE event exceeded the safety limit.")
        }
        const parsed = parseRecord(record)
        if (parsed) yield parsed
        boundary = findBoundary(buffer)
      }
      if (done) break
    }
    if (buffer.trim()) {
      if (buffer.length > MAX_SSE_EVENT_BYTES) {
        throw new Error("[SixbOpenResponses] SSE event exceeded the safety limit.")
      }
      const parsed = parseRecord(buffer)
      if (parsed) yield parsed
    }
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

function parseRecord(record: string): ServerSentEvent | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of record.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")) {
    if (!line || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    const raw = colon === -1 ? "" : line.slice(colon + 1)
    const value = raw.startsWith(" ") ? raw.slice(1) : raw
    if (field === "event") event = value
    if (field === "data") data.push(value)
  }
  if (data.length === 0) return null
  return { ...(event === undefined ? {} : { event }), data: data.join("\n") }
}

function findBoundary(buffer: string): { readonly index: number; readonly length: number } | null {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index !== -1)
  candidates.sort((left, right) => left.index - right.index)
  return candidates[0] ?? null
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException("Aborted", "AbortError")
}
