import { expect, test } from "bun:test"
import { FoundryTransport } from "../src/transport"

// Regression proof: remove redirect: "error" from post() and run this file.
// The redirect destination receives credentials (and the body for 307/308).
for (const protocol of ["responses", "chat", "messages", "embeddings"] as const) {
  test.each([
    301, 302, 303, 307, 308,
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
        const transport = new FoundryTransport(
          {
            endpoint:
              protocol === "embeddings"
                ? origin.url.origin
                : `${origin.url.origin}/api/projects/test`,
            apiKey: "private-key",
          },
          protocol === "embeddings" ? "resource" : "project"
        )
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
