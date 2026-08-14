import { afterEach, describe, expect, test } from "bun:test"
import {
  client,
  createAuthPersonalAccessToken,
  createSixbClient,
  isSixbApiError,
  listAuthAccessTokens,
  normalizeSixbApiBaseUrl,
  requestSyncRun,
  SixbApiError,
} from "../src"

afterEach(() => {
  client.setConfig({
    auth: undefined,
    baseUrl: undefined,
    credentials: undefined,
    fetch: undefined,
  })
})

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

function createRespondingFetch(response: () => Response) {
  return Object.assign(async () => response(), { preconnect: fetch.preconnect }) as typeof fetch
}

describe("SixbApiError", () => {
  test("normalizes errors from the documented shared-client setup", async () => {
    client.setConfig({
      baseUrl: "http://localhost:3002",
      fetch: createRespondingFetch(
        () =>
          new Response(JSON.stringify({ error: "Dataset not found", code: "dataset.not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      ),
    })

    const error = (await listAuthAccessTokens({ throwOnError: true }).catch(
      (caught) => caught
    )) as SixbApiError

    expect(error).toBeInstanceOf(SixbApiError)
    expect(error.status).toBe(404)
    expect(error.code).toBe("dataset.not_found")
  })

  test("wraps a plain-text error response with status and body", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: createRespondingFetch(() => new Response("Not Found", { status: 404 })),
    })

    const promise = listAuthAccessTokens({ client, throwOnError: true })
    await expect(promise).rejects.toBeInstanceOf(SixbApiError)

    const error = (await promise.catch((caught) => caught)) as SixbApiError
    expect(error.status).toBe(404)
    expect(error.code).toBeUndefined()
    expect(error.body).toBe("Not Found")
    expect(error.method).toBe("GET")
    expect(error.url).toContain("/api/auth/access-tokens")
    expect(error.message).toContain("404")
    expect(error.message).toContain("/api/auth/access-tokens")
    expect(error.message).toContain("Not Found")
    expect(isSixbApiError(error)).toBe(true)
  })

  test("surfaces a stable code from a structured error response", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: createRespondingFetch(
        () =>
          new Response(JSON.stringify({ error: "Dataset not found", code: "dataset.not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          })
      ),
    })

    const error = (await listAuthAccessTokens({ client, throwOnError: true }).catch(
      (caught) => caught
    )) as SixbApiError
    expect(error.status).toBe(404)
    expect(error.code).toBe("dataset.not_found")
    expect(error.body).toEqual({ error: "Dataset not found", code: "dataset.not_found" })
    expect(error.message).toContain("Dataset not found")
  })

  test("preserves codes introduced by a newer server", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: createRespondingFetch(
        () =>
          new Response(JSON.stringify({ error: "Future failure", code: "future.new_code" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
      ),
    })

    const error = (await listAuthAccessTokens({ client, throwOnError: true }).catch(
      (caught) => caught
    )) as SixbApiError
    expect(error.code).toBe("future.new_code")
  })

  test("surfaces the structured error on the non-throwing result path too", async () => {
    const client = createSixbClient({
      baseUrl: "http://localhost:3002",
      fetch: createRespondingFetch(() => new Response("Boom", { status: 500 })),
    })

    const { data, error } = await listAuthAccessTokens({ client })
    expect(data).toBeUndefined()
    expect(isSixbApiError(error)).toBe(true)
    expect((error as unknown as SixbApiError).status).toBe(500)
  })

  test("isSixbApiError recognizes structurally-equal errors across bundles", () => {
    const lookalike = { name: "SixbApiError", status: 404, body: "Not Found" }
    expect(isSixbApiError(lookalike)).toBe(true)
    expect(isSixbApiError(new Error("nope"))).toBe(false)
    expect(isSixbApiError("Not Found")).toBe(false)
  })
})
