import { afterEach, expect, jest, test } from "bun:test"
import { FoundryTransport } from "../src/transport"

// A timed-out test skips its own cleanup; never leak fake timers into later tests.
afterEach(() => {
  jest.useRealTimers()
})

// Regression proof: directly await fetch in post(). The watchdog wins instead of
// caller cancellation, and a late response's body is never released.
test("cancellation bounds an uncooperative fetch and releases late responses", async () => {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  const cancelled = Promise.withResolvers<unknown>()
  let calls = 0
  const transport = new FoundryTransport({
    endpoint: "https://example.test/api/projects/test",
    apiKey: "key",
    fetch: () => {
      calls++
      entered.resolve()
      return pending.promise
    },
  })
  const controller = new AbortController()
  const reason = new Error("caller cancelled")
  const post = transport.post("{}", controller.signal, "provider", "model").then(
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
    endpoint: "https://example.test/api/projects/test",
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

// Regression proof: drop the abort listener in transport.ts wait(). The 60-second
// Retry-After wait then outlives the caller and the request never settles.
test("cancellation interrupts a retry wait", async () => {
  jest.useFakeTimers()
  let calls = 0
  const transport = new FoundryTransport({
    endpoint: "https://example.test/api/projects/test",
    apiKey: "key",
    fetch: async () => {
      calls++
      return new Response(null, { status: 503, headers: { "retry-after": "60" } })
    },
  })
  const controller = new AbortController()
  const reason = new Error("cancel retry")
  const post = transport.post("{}", controller.signal, "provider", "model").then(
    () => "unexpected response",
    (error) => error
  )
  for (let turn = 0; turn < 100 && jest.getTimerCount() === 0; turn++) await Promise.resolve()
  expect(jest.getTimerCount()).toBe(1)
  controller.abort(reason)
  expect(await post).toBe(reason)
  expect(jest.getTimerCount()).toBe(0)
  expect(calls).toBe(1)
})
