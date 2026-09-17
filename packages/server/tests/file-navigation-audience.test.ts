import { describe, expect, test } from "bun:test"
import { SIXB_API_ROUTES } from "@sixb/core/internal/http"
import { resolveApiBrowserAuthContext, resolveApiBrowserPolicy } from "../src/auth/browser-origin"
import { createTestBrowserPolicy } from "./helpers"

const policy = resolveApiBrowserPolicy(createTestBrowserPolicy())
const path = "/api/objects/document/doc-1/files/content"
const request = (query: string, method = "GET", pathname = path) =>
  new Request(`http://api.localhost${pathname}?${query}`, { method })

describe("file navigation audience policy", () => {
  test("supports every registered file read and leaves other methods unchanged", () => {
    for (const route of SIXB_API_ROUTES.filter((entry) => entry.path.endsWith("/files/content"))) {
      expect(
        resolveApiBrowserAuthContext(policy, request("audience=app", route.method, route.path))
          .audience
      ).toBe("app")
    }
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      expect(resolveApiBrowserAuthContext(policy, request("audience=app", method)).audience).toBe(
        "atlas"
      )
    }
    expect(
      resolveApiBrowserAuthContext(policy, request("audience=app", "GET", "/api/objects")).audience
    ).toBe("atlas")
  })

  test("rejects invalid, duplicate, and unconfigured audiences", () => {
    for (const query of [
      "audience=",
      "audience=unknown",
      "audience=app&audience=app",
      "audience=app&audience=atlas",
    ]) {
      expect(() => resolveApiBrowserAuthContext(policy, request(query))).toThrow(
        "audience is not allowed"
      )
    }
    const atlasOnly = resolveApiBrowserPolicy(createTestBrowserPolicy({ includeApp: false }))
    expect(() => resolveApiBrowserAuthContext(atlasOnly, request("audience=app"))).toThrow(
      "audience is not allowed"
    )
    const appDefault = { ...atlasOnly, apiOriginAudience: "app" as const }
    expect(resolveApiBrowserAuthContext(appDefault, request("audience=app")).audience).toBe("app")
    expect(resolveApiBrowserAuthContext(appDefault, request("")).audience).toBe("app")
  })
})
