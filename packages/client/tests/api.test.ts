import { describe, expect, test } from "bun:test"
import {
  createAuthPersonalAccessToken,
  createSixbClient,
  listAuthAccessTokens,
  normalizeSixbApiBaseUrl,
  requestSyncRun,
} from "../src"

function createObservedFetch(responseBody: unknown = {}) {
  const requests: Request[] = []
  const fetchMock = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(input instanceof Request && !init ? input : new Request(input, init))
      return Response.json(responseBody)
    },
    { preconnect: fetch.preconnect }
  ) satisfies typeof fetch

  return { fetchMock, requests }
}

describe("createSixbClient", () => {
  test("normalizes API base URLs with or without /api", () => {
    expect(normalizeSixbApiBaseUrl("http://localhost:3002")).toBe("http://localhost:3002")
    expect(normalizeSixbApiBaseUrl("http://localhost:3002/api")).toBe("http://localhost:3002")
    expect(normalizeSixbApiBaseUrl("https://api.example.com/sixb/api")).toBe(
      "https://api.example.com/sixb"
    )
  })

  test("sends bearer tokens only for bearer security schemes", async () => {
    const { fetchMock, requests } = createObservedFetch({ accessTokens: [] })
    const client = createSixbClient({
      baseUrl: "http://localhost:3002/api",
      auth: { kind: "bearer", token: "sixb_pat_tok_test.secret" },
      fetch: fetchMock,
    })

    await listAuthAccessTokens({ client })

    expect(requests[0]?.url).toBe("http://localhost:3002/api/auth/access-tokens")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sixb_pat_tok_test.secret")
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBeNull()
  })

  test("rejects empty bearer tokens", () => {
    expect(() =>
      createSixbClient({
        auth: { kind: "bearer", token: "   " },
      })
    ).toThrow("[SixbClient] Bearer token cannot be empty.")
  })

  test("uses bearer instead of CSRF when an operation supports both", async () => {
    const { fetchMock, requests } = createObservedFetch({
      accessToken: {
        id: "tok_1",
        name: "CLI",
        kind: "personal",
        status: "active",
        subjectType: "user",
        subjectId: "usr_1",
        createdAt: "2026-06-21T00:00:00.000Z",
        expiresAt: "2026-09-19T00:00:00.000Z",
      },
      tokenValue: "sixb_pat_tok_1.secret",
    })
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      auth: { kind: "bearer", token: "sixb_pat_tok_test.secret" },
      fetch: fetchMock,
    })

    await createAuthPersonalAccessToken({
      client,
      body: {
        name: "CLI",
        expiresAt: "2026-09-19T00:00:00.000Z",
      },
    })

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sixb_pat_tok_test.secret")
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBeNull()
  })

  test("sends CSRF and credentials for cookie auth", async () => {
    const { fetchMock, requests } = createObservedFetch({
      id: "run_1",
      syncId: "sync_1",
      status: "queued",
    })
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      auth: { kind: "cookie", csrfToken: () => "csrf_1" },
      fetch: fetchMock,
    })

    await requestSyncRun({
      client,
      body: {},
      path: { syncId: "sync_1" },
    })

    expect(requests[0]?.credentials).toBe("include")
    expect(requests[0]?.headers.get("x-sixb-csrf")).toBe("csrf_1")
    expect(requests[0]?.headers.get("authorization")).toBeNull()
  })
})
