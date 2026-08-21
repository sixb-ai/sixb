import { describe, expect, test } from "bun:test"
import { createSharedAccessClient } from "../src/shared"

const grantId = "shr_1"
const secret = "A".repeat(43)

describe("shared access client", () => {
  test("owns credentials and CSRF state independently", async () => {
    const requests: Request[] = []
    const client = createSharedAccessClient({
      baseUrl: "https://api.example.test",
      fetch: mockFetch(async (request) => {
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/exchange")) {
          return jsonResponse({
            authenticated: true,
            csrfToken: "csrf_shared",
            grant: {
              id: grantId,
              shareTypeId: "published-report",
              target: { objectTypeId: "report", primaryId: "report-1" },
              grants: [{ capability: "view", objectTypeId: "report" }],
              expiresAt: "2026-08-21T12:00:00.000Z",
            },
            session: { expiresAt: "2026-08-20T12:15:00.000Z" },
          })
        }
        if (pathname.endsWith("/sign-out")) return jsonResponse({ signedOut: true })
        return jsonResponse({ authenticated: false })
      }),
    })

    await client.exchange({ grantId, secret })
    await client.signOut(grantId)

    expect(requests).toHaveLength(2)
    expect(requests[0]?.credentials).toBe("include")
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBeNull()
    expect(requests[1]?.headers.get("x-sixb-csrf")).toBe("csrf_shared")
  })

  test("rejects malformed link input before issuing a request", async () => {
    let called = false
    const client = createSharedAccessClient({
      fetch: mockFetch(async () => {
        called = true
        return jsonResponse({ authenticated: false })
      }),
    })

    await expect(client.exchange({ grantId, secret: "short" })).rejects.toThrow(
      "Shared access secret is invalid"
    )
    expect(called).toBe(false)
  })

  test("surfaces the stable code for an unavailable link", async () => {
    const client = createSharedAccessClient({
      baseUrl: "https://api.example.test",
      fetch: mockFetch(async () =>
        jsonResponse(
          {
            error: "Shared access is unavailable.",
            code: "share.access_unavailable",
          },
          401
        )
      ),
    })

    await expect(client.exchange({ grantId, secret })).rejects.toMatchObject({
      name: "SixbApiError",
      status: 401,
      code: "share.access_unavailable",
    })
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function mockFetch(run: (request: Request) => Promise<Response>): typeof fetch {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      run(input instanceof Request ? input : new Request(input, init)),
    { preconnect: fetch.preconnect }
  )
}
