import { describe, expect, test } from "bun:test"
import { classifyRoute } from "../src/auth/public-routes"

function request(method: string, path: string): Request {
  return new Request(`http://api.localhost${path}`, { method })
}

const FRAME_FILE = `/api/artifact-frames/${"t".repeat(43)}/index.html`

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
  ["POST", "/api/webhooks/github/events", "third-party callers sign their payloads"],
  ["GET", "/api/files/downloads/payload.signature", "the signed token is the credential"],
  ["HEAD", "/api/files/downloads/payload.signature", "media fetchers probe before reading"],
  ["GET", FRAME_FILE, "a sandboxed frame holds no session; the link's token is the credential"],
  ["HEAD", FRAME_FILE, "a sandboxed frame holds no session; the link's token is the credential"],
  ["GET", "/api/auth/session", "answers whether a session exists"],
  ["POST", "/api/auth/sign-out", "must work with an expired session"],
  ["POST", "/api/auth/device-authorizations", "starts a device authorization"],
  ["POST", "/api/auth/device-authorizations/token", "device code authenticates polling"],
  ["POST", "/auth/device", "handler verifies session and submitted CSRF token"],
  ["POST", "/api/shared-access/shr_1/exchange", "link secret authenticates the exchange"],
  ["GET", "/api/shared-access/shr_1/session", "grant-specific cookie authenticates the session"],
  ["POST", "/api/shared-access/shr_1/sign-out", "shared CSRF authenticates sign-out"],
  ["GET", "/auth/assets/auth-example.js", "custom auth experience asset"],
  ["HEAD", "/auth/assets/auth-example.js", "custom auth experience asset metadata"],
  ["GET", "/auth/sign-in", "the page that creates a session"],
  ["POST", "/auth/sign-in", "the page that creates a session"],
  ["GET", "/auth/sign-in/device", "the cookie from starting the request authenticates the wait"],
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

  test("an unrecognized path requires authentication, and CSRF protection to mutate", () => {
    // These 404 in the router before the guard runs, so none of them was ever exposed.
    // The default still matters: it decides what happens to the next route someone
    // mounts outside /api, /ws and /docs. See the auth-guard integration test for the
    // registered-route case.
    for (const path of ["/", "/admin", "/internal/metrics", "/.env", "/api-docs"]) {
      expect(classifyRoute(request("GET", path)), `GET ${path}`).toEqual({
        kind: "api",
        csrfProtected: false,
      })
      // Failing closed has to fail closed all the way: an unclassified POST that needed
      // auth but skipped CSRF would still be reachable from another origin's page.
      expect(classifyRoute(request("POST", path)), `POST ${path}`).toEqual({
        kind: "api",
        csrfProtected: true,
      })
    }
  })

  // The allow-list holds the methods each of these is public for; every other one needs a session.
  // Reproduce by dropping the method check from one of their rules in classifyRoute.
  test.each([
    // `WebhookDefinition.method` is the literal "POST", so no other method is ever registered
    // under this prefix and a wider allow-list allows nothing real.
    ["/api/webhooks/github/events", ["GET", "PUT", "PATCH", "DELETE"]],
    ["/api/files/downloads/payload.signature", ["POST", "PUT", "PATCH", "DELETE"]],
    [FRAME_FILE, ["POST", "PUT", "PATCH", "DELETE"]],
  ] as const)("%s needs a session for any other method", (path, methods) => {
    for (const method of methods) {
      expect(classifyRoute(request(method, path)).kind, `${method} ${path}`).toBe("api")
    }
  })

  test("shared-access lifecycle routes are public only for their exact method and shape", () => {
    // The exact routes are in the allow-list above.
    for (const [method, path] of [
      ["GET", "/api/shared-access/shr_1/exchange"],
      ["POST", "/api/shared-access/shr_1/session"],
      ["GET", "/api/shared-access/shr_1/sign-out"],
      ["POST", "/api/shared-access/shr_1/unknown"],
      ["POST", "/api/shared-access/shr_1/extra/exchange"],
    ] as const) {
      expect(classifyRoute(request(method, path)).kind, `${method} ${path}`).toBe("api")
    }
  })

  test("nothing under the /__sixb prefix is public", () => {
    // The app serves its own /__sixb/runtime.json from its own server, and run tokens reach the
    // normal routes, so nothing on the API under /__sixb needs to skip authentication.
    expect(classifyRoute(request("GET", "/__sixb/runtime.json")).kind).toBe("api")
    expect(classifyRoute(request("POST", "/__sixb/agent-api/objects")).kind).toBe("api")
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
    expect(classifyRoute(request("GET", "/auth/device?user_code=BCDF-HJKM")).kind).toBe("html")
  })
})
