import { describe, expect, test } from "bun:test"
import { classifyRoute } from "../src/auth/public-routes"

function request(method: string, path: string): Request {
  return new Request(`http://api.localhost${path}`, { method })
}

// The complete set of paths the API server answers without a session. Anything not
// here must require authentication — that is the invariant this file exists to hold,
// because the classifier used to default to "public" and would have handed a new
// route out unauthenticated unless someone remembered to classify it.
const PUBLIC: ReadonlyArray<readonly [string, string, string]> = [
  ["OPTIONS", "/api/objects", "CORS preflight carries no credentials"],
  ["OPTIONS", "/anything/at/all", "preflight is method-scoped, not path-scoped"],
  ["GET", "/favicon.svg", "browser chrome"],
  ["GET", "/favicon.ico", "browser chrome"],
  ["GET", "/health", "liveness probe"],
  ["GET", "/ready", "readiness probe"],
  ["POST", "/__sixb/agent-api/objects", "gateway authenticates with the run's own token"],
  ["POST", "/api/webhooks/github/events", "third-party callers sign their payloads"],
  ["GET", "/api/auth/session", "answers whether a session exists"],
  ["POST", "/api/auth/sign-out", "must work with an expired session"],
  ["GET", "/auth/sign-in", "the page that creates a session"],
  ["POST", "/auth/sign-in", "the page that creates a session"],
  ["GET", "/auth/callback", "the emailed token IS the credential"],
  ["POST", "/auth/callback", "the emailed token IS the credential"],
  ["GET", "/auth/connectors/callback", "one-use state, browser binding and PKCE authenticate it"],
  [
    "GET",
    "/auth/connectors/callback/",
    "some OAuth providers require the registered redirect URI to end in a slash",
  ],
]

describe("classifyRoute", () => {
  test("keeps exactly the documented allow-list public", () => {
    for (const [method, path, why] of PUBLIC) {
      expect(classifyRoute(request(method, path)).kind, `${method} ${path} — ${why}`).toBe("public")
    }
  })

  test("an unrecognized path requires authentication", () => {
    // These 404 in the router before the guard runs, so none of them was ever exposed.
    // The default still matters: it decides what happens to the next route someone
    // mounts outside /api, /ws and /docs. See the auth-guard integration test for the
    // registered-route case.
    for (const path of ["/", "/admin", "/internal/metrics", "/.env", "/api-docs"]) {
      expect(classifyRoute(request("GET", path)).kind, `GET ${path}`).toBe("api")
      expect(classifyRoute(request("POST", path)).kind, `POST ${path}`).toBe("api")
    }
  })

  test("a webhook path is public for POST alone", () => {
    // `WebhookDefinition.method` is the literal "POST", so no other method is ever
    // registered under this prefix and a wider allow-list allows nothing real. It was
    // written method-blind, which made the entry read like a path-shaped hole.
    expect(classifyRoute(request("POST", "/api/webhooks/github/events")).kind).toBe("public")
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      expect(
        classifyRoute(request(method, "/api/webhooks/github/events")).kind,
        `${method} /api/webhooks/github/events`
      ).toBe("api")
    }
  })

  test("the /__sixb prefix is public only for the agent gateway", () => {
    // A blanket GET rule for /__sixb used to sit beside the gateway rule. It was a
    // second, narrower fail-open: Atlas serves its own /__sixb/runtime.json from its
    // own server, so nothing on the API needed it.
    expect(classifyRoute(request("GET", "/__sixb/runtime.json")).kind).toBe("api")
    expect(classifyRoute(request("GET", "/__sixb/agent-api/objects")).kind).toBe("public")
  })

  test("classifies the three authenticated families", () => {
    expect(classifyRoute(request("GET", "/api/objects"))).toEqual({
      kind: "api",
      csrfProtected: false,
    })
    expect(classifyRoute(request("POST", "/api/objects/query"))).toEqual({
      kind: "api",
      csrfProtected: true,
    })
    expect(classifyRoute(request("GET", "/ws/events")).kind).toBe("websocket")
    expect(classifyRoute(request("GET", "/docs")).kind).toBe("html")
    expect(classifyRoute(request("GET", "/docs/json")).kind).toBe("html")
  })

  test("a mutation to an unrecognized path is CSRF-protected", () => {
    // Failing closed has to fail closed all the way: an unclassified POST that needed
    // auth but skipped CSRF would still be reachable from another origin's page.
    expect(classifyRoute(request("POST", "/whatever")).csrfProtected).toBe(true)
    expect(classifyRoute(request("GET", "/whatever")).csrfProtected).toBe(false)
  })
})
