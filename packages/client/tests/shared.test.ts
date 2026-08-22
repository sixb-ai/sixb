import { afterEach, describe, expect, test } from "bun:test"
import { client as sixbClient } from "../src"
import { createSharedAccessClient } from "../src/shared"

const grantId = "shr_1"
const secret = "A".repeat(43)

afterEach(() => {
  sixbClient.setConfig({
    baseUrl: undefined,
    fetch: undefined,
    headers: { authorization: null },
  })
})

describe("shared access client", () => {
  test("requires its grant boundary at construction", () => {
    expect(() => createSharedAccessClient(undefined as never)).toThrow(
      "Shared access grant id must not be empty"
    )
  })

  test("owns credentials and CSRF state independently", async () => {
    const requests: Request[] = []
    const client = createSharedAccessClient({
      grantId,
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

    await client.exchange(secret)
    await client.signOut()

    expect(requests).toHaveLength(2)
    expect(requests[0]?.credentials).toBe("include")
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBeNull()
    expect(requests[1]?.headers.get("x-sixb-csrf")).toBe("csrf_shared")
  })

  test("creates a grant-bound client from the configured Sixb client", async () => {
    const requests: Request[] = []
    sixbClient.setConfig({
      baseUrl: "https://api.example.test",
      fetch: mockFetch(async (request) => {
        requests.push(request.clone())
        return jsonResponse({ authenticated: false })
      }),
      headers: { authorization: "Bearer ambient" },
    })

    const shared = sixbClient.shared(grantId)
    await shared.getSession()

    expect(requests[0]?.url).toBe(`https://api.example.test/api/shares/${grantId}/session`)
    expect(requests[0]?.credentials).toBe("include")
    expect(requests[0]?.headers.get("authorization")).toBeNull()
  })

  test("rejects malformed link input before issuing a request", async () => {
    let called = false
    const client = createSharedAccessClient({
      grantId,
      fetch: mockFetch(async () => {
        called = true
        return jsonResponse({ authenticated: false })
      }),
    })

    await expect(client.exchange("short")).rejects.toThrow("Shared access secret is invalid")
    expect(called).toBe(false)
  })

  test("surfaces the stable code for an unavailable link", async () => {
    const client = createSharedAccessClient({
      grantId,
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

    await expect(client.exchange(secret)).rejects.toMatchObject({
      name: "SixbApiError",
      status: 401,
      code: "share.access_unavailable",
    })
  })

  test("keeps CSRF state scoped to the bound grant", async () => {
    const requests: Request[] = []
    const csrfTokens = new Map([
      ["shr_first", "csrf_first"],
      ["shr_second", "csrf_second"],
    ])
    sixbClient.setConfig({
      baseUrl: "https://api.example.test",
      fetch: mockFetch(async (request) => {
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/exchange")) {
          const boundGrantId = pathname.split("/").at(-2) ?? ""
          return jsonResponse({
            authenticated: true,
            csrfToken: csrfTokens.get(boundGrantId),
            grant: {
              id: boundGrantId,
              shareTypeId: "published-report",
              target: { objectTypeId: "report", primaryId: "report-1" },
              grants: [{ capability: "view", objectTypeId: "report" }],
              expiresAt: "2026-08-21T12:00:00.000Z",
            },
            session: { expiresAt: "2026-08-20T12:15:00.000Z" },
          })
        }
        return jsonResponse({ signedOut: true })
      }),
    })

    const first = sixbClient.shared("shr_first")
    const second = sixbClient.shared("shr_second")
    await first.exchange(secret)
    await second.exchange(secret)
    await first.signOut()

    expect(new URL(requests[2]?.url ?? "").pathname).toBe("/api/shares/shr_first/sign-out")
    expect(requests[2]?.headers.get("x-sixb-csrf")).toBe("csrf_first")
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
