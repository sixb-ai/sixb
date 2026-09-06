import { expect, test } from "bun:test"
import { decodeServerSentEvents } from "../src/sse"

// Regression proof: remove cancellation from the decoder's finally block.
test("cancels unfinished SSE bodies on consumer return and preserves consumer errors", async () => {
  for (const fail of [false, true]) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"))
      },
      cancel() {
        cancelled = true
        throw new Error("cleanup failed")
      },
    })
    const failure = new Error("consumer failed")
    const consume = async () => {
      for await (const event of decodeServerSentEvents(body, new AbortController().signal)) {
        expect(event.data).toBe("first")
        if (fail) throw failure
        break
      }
    }
    if (fail) await expect(consume()).rejects.toBe(failure)
    else await consume()
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  }
})

test("releases normally completed SSE bodies", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: last\n\n"))
      controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const events = []
  for await (const event of decodeServerSentEvents(body, new AbortController().signal))
    events.push(event)
  expect(events).toEqual([{ data: "last" }])
  expect(cancelled).toBe(false)
  expect(body.locked).toBe(false)
})
