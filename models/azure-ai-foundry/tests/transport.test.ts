import { afterEach, expect, jest, test } from "bun:test"
import { RequestDiagnostics } from "../src/diagnostics"
import { type AzureAIFoundryCredential, FoundryTransport } from "../src/transport"

// A timed-out test skips its own cleanup; never leak fake timers into later tests.
afterEach(() => {
  jest.useRealTimers()
})

// Regression proof: remove redirect: "error" from post() and run this file.
// The redirect destination receives credentials (and the body for 307/308).
for (const protocol of ["responses", "chat", "messages", "embeddings"] as const) {
  // 302 is rewritten to GET; 307 would replay the POST body to the new origin.
  test.each([
    302, 307,
  ])(`${protocol} rejects HTTP %s redirects without forwarding credentials or prompts`, async (status) => {
    let forwarded = 0
    let attempts = 0
    const received: { key: string | null; body: string }[] = []
    const body = JSON.stringify({ prompt: "private prompt" })
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        forwarded++
        return new Response("unexpected redirect")
      },
    })
    try {
      const origin = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          attempts++
          received.push({
            key: request.headers.get(protocol === "messages" ? "x-api-key" : "api-key"),
            body: await request.text(),
          })
          return new Response(null, {
            status,
            headers: { location: destination.url.href },
          })
        },
      })
      try {
        const transport = new FoundryTransport({
          endpoint: `${origin.url.origin}/api/projects/test`,
          apiKey: "private-key",
        })
        const result = await transport
          .post(body, AbortSignal.timeout(2_000), "provider", "model", protocol)
          .then(
            () => "resolved",
            () => "rejected"
          )
        expect(forwarded).toBe(0)
        expect(result).toBe("rejected")
        expect(attempts).toBe(1)
        expect(received).toEqual([{ key: "private-key", body }])
      } finally {
        await origin.stop(true)
      }
    } finally {
      await destination.stop(true)
    }
  })
}

/** The credential's token for one call, or the call's failure. */
function signed(credential: AzureAIFoundryCredential) {
  const transport = new FoundryTransport({
    endpoint: "https://resource.services.ai.azure.com/api/projects/test",
    credential,
  })
  return (signal = new AbortController().signal) =>
    transport.headers(signal, new RequestDiagnostics()).then(
      (headers) => headers.get("authorization"),
      (error: Error) => `failed: ${error.message}`
    )
}

/** Lets a background renewal settle; microtasks only, so it also runs under fake timers. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

// Regression proof: await renewToken() in bearerToken whenever the token is due for renewal.
// The second call then waits for, and returns, the new token.
test("a token due for renewal is renewed in the background while calls keep using it", async () => {
  const issued: string[] = []
  const call = signed({
    getToken: async () => {
      issued.push(`t${issued.length + 1}`)
      // The first token is two minutes from expiry; the renewed one, an hour.
      const lifetime = issued.length === 1 ? 90_000 : 3_600_000
      return { token: issued.at(-1)!, expiresOnTimestamp: Date.now() + lifetime }
    },
  })
  expect(await call()).toBe("Bearer t1")
  expect(await call()).toBe("Bearer t1")
  await settle()
  expect(await call()).toBe("Bearer t2")
  expect(issued).toEqual(["t1", "t2"])
})

// Regression proof: let a failed background renewal reject the call, or drop the retry delay.
// The second call then fails, or every call asks the credential again.
test("a failed renewal keeps the valid token and waits before asking again", async () => {
  let calls = 0
  const call = signed({
    getToken: async () => {
      if (++calls > 1) throw new Error("token service unavailable")
      return { token: "valid", expiresOnTimestamp: Date.now() + 90_000 }
    },
  })
  expect(await call()).toBe("Bearer valid")
  expect(await call()).toBe("Bearer valid")
  await settle()
  expect(await call()).toBe("Bearer valid")
  expect(calls).toBe(2)
})

// Managed identity tokens can live for a day and name an earlier refresh time.
test("the credential's refreshAfterTimestamp starts a renewal", async () => {
  let calls = 0
  const call = signed({
    getToken: async () => ({
      token: `t${++calls}`,
      expiresOnTimestamp: Date.now() + 24 * 3_600_000,
      refreshAfterTimestamp: Date.now() - 1,
    }),
  })
  await call()
  await call()
  expect(calls).toBe(2)
})

// Regression proof: remove the timer in renewToken. The renewal never settles, and the second
// call waits on it instead of asking the credential again.
test("a getToken call that never settles is abandoned after 30 seconds", async () => {
  jest.useFakeTimers()
  let calls = 0
  const call = signed({
    getToken: () =>
      ++calls === 1
        ? new Promise(() => {})
        : Promise.resolve({ token: "recovered", expiresOnTimestamp: Date.now() + 3_600_000 }),
  })
  const waiting = new AbortController()
  const first = call(waiting.signal)
  await settle()
  waiting.abort(new Error("caller gave up"))
  expect(await first).toBe("failed: caller gave up")
  expect(calls).toBe(1)
  jest.advanceTimersByTime(30_000)
  await settle()
  expect(await call()).toBe("Bearer recovered")
  expect(calls).toBe(2)
})
