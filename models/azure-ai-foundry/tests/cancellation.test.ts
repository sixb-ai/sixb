import { expect, test } from "bun:test"
import { FoundryTransport } from "../src/transport"

// Regression proof: directly await fetch in post(). The watchdog wins instead of
// caller cancellation, and a late response's body is never released.
test.each([
  "responses",
  "chat",
  "messages",
] as const)("%s cancellation bounds an uncooperative fetch and releases late responses", async (protocol) => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  const cancelled = Promise.withResolvers<unknown>()
  let calls = 0
  const transport = new FoundryTransport({
    endpoint: "https://example.test",
    apiKey: "key",
    fetch: () => {
      calls++
      entered.resolve()
      return pending.promise
    },
  })
  const controller = new AbortController()
  const reason = new Error("caller cancelled")
  const post = transport.post("{}", controller.signal, "provider", "model", protocol).then(
    () => "unexpected response",
    (error) => error
  )
  await entered.promise
  controller.abort(reason)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      post,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("watchdog"), 100)
      }),
    ])
    expect(result).toBe(reason)
    pending.resolve(new Response(new ReadableStream({ cancel: cancelled.resolve })))
    expect(await cancelled.promise).toBe(reason)
    expect(calls).toBe(1)
  } finally {
    clearTimeout(timer)
    pending.resolve(new Response())
    await post
  }
})

// Regression proof: await reader.cancel() in httpError's finally block. A stream
// whose underlying cancel never settles traps the caller even after abort.
test("cancellation does not await an uncooperative HTTP error body's cleanup", async () => {
  const entered = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  const controller = new AbortController()
  const transport = new FoundryTransport({
    endpoint: "https://example.test",
    apiKey: "key",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array(8192))
          },
          cancel() {
            entered.resolve()
            return cleanup.promise
          },
        }),
        { status: 429 }
      ),
  })
  const reason = new Error("cancel during error body")
  const post = transport.post("{}", controller.signal, "provider", "model").then(
    () => "unexpected response",
    (error) => error
  )
  await entered.promise
  controller.abort(reason)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        post,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve("watchdog"), 100)
        }),
      ])
    ).toBe(reason)
  } finally {
    clearTimeout(timer)
    cleanup.resolve()
    await post
  }
})
