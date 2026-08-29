import { describe, expect, test } from "bun:test"
import {
  AuthorizationError,
  type IssueSharedAccessByIdInput,
  type ListSharedAccessByIdInput,
  type SharedAccessGrant,
  ShareError,
  type SharesRuntime,
  type SixbHostView,
} from "@sixb/core"
import { Elysia } from "elysia"
import {
  isAccessTokenRoute,
  shouldVerifyCsrfForAuthSource,
} from "../src/auth/access-token-boundary"
import { classifyRoute } from "../src/auth/public-routes"
import { registerShareGrantRoutes } from "../src/routes/share-grants"

const createdAt = new Date("2026-08-28T12:00:00.000Z")
const expiresAt = new Date("2026-08-29T12:00:00.000Z")

const activeGrant: SharedAccessGrant = {
  id: "shr_1",
  definitionId: "published-report",
  target: { objectTypeId: "Report", primaryId: "report-1" },
  // Durable principals are not HTTP request identifiers. Response serialization must preserve
  // their exact Core-valid value without trimming or imposing an unrelated request-size cap.
  issuedBy: { type: "user", id: ` ${"u".repeat(300)} ` },
  destinationPath: "/reports/report-1",
  createdAt,
  expiresAt,
}

describe("shared-access grant routes", () => {
  test("issues, lists, and revokes grants without exposing durable authority", async () => {
    let issuedInput: IssueSharedAccessByIdInput | undefined
    let listedInput: ListSharedAccessByIdInput | undefined
    let revokedId: string | undefined
    const revokedAt = new Date("2026-08-28T13:00:00.000Z")
    const revokedGrant: SharedAccessGrant = {
      ...activeGrant,
      revokedAt,
      revokedBy: { type: "serviceAccount", id: ` ${"s".repeat(300)} ` },
    }
    const app = createTestApp({
      issueById: async (input) => {
        issuedInput = input
        return { grant: activeGrant, secret: "share_secret" }
      },
      listById: async (input) => {
        listedInput = input
        return { grants: [activeGrant, revokedGrant], total: 2, hasMore: false }
      },
      revoke: async (grantId) => {
        revokedId = grantId
        return revokedGrant
      },
    })

    const issued = await app.handle(
      jsonRequest("/api/share-grants", "POST", {
        definitionId: "published-report",
        target: { objectTypeId: "Report", primaryId: "report-1" },
        destinationPath: "/reports/report-1",
        expiresAt: expiresAt.toISOString(),
      })
    )
    expect(issued.status).toBe(201)
    expect(issued.headers.get("cache-control")).toBe("no-store")
    expect(issuedInput).toEqual({
      definitionId: "published-report",
      target: { objectTypeId: "Report", primaryId: "report-1" },
      destinationPath: "/reports/report-1",
      expiresAt,
    })
    const issuedBody = (await issued.json()) as Record<string, unknown>
    expect(issuedBody).toEqual({
      grant: serializedGrant(activeGrant),
      url: "/shared/shr_1/reports/report-1#share_secret",
    })
    expect(issuedBody).not.toHaveProperty("secret")
    expect(issuedBody).not.toHaveProperty("authoritySnapshot")
    expect(issuedBody).not.toHaveProperty("tokenHash")

    const listed = await app.handle(
      new Request(
        "http://localhost/api/share-grants?definitionId=published-report&primaryId=report-1&includeRevoked=true&includeExpired=false&limit=25&offset=5"
      )
    )
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    expect(listedInput).toEqual({
      definitionId: "published-report",
      primaryId: "report-1",
      includeRevoked: true,
      includeExpired: false,
      limit: 25,
      offset: 5,
    })
    expect(await listed.json()).toEqual({
      grants: [serializedGrant(activeGrant), serializedGrant(revokedGrant)],
      total: 2,
      hasMore: false,
    })

    const revoked = await app.handle(
      new Request("http://localhost/api/share-grants/shr_1", { method: "DELETE" })
    )
    expect(revoked.status).toBe(200)
    expect(revoked.headers.get("cache-control")).toBe("no-store")
    expect(revokedId).toBe("shr_1")
    expect(await revoked.json()).toEqual({ grant: serializedGrant(revokedGrant) })
  })

  test("returns a stable 404 when revocation cannot find the project-scoped grant", async () => {
    const app = createTestApp({ revoke: async () => null })
    const response = await app.handle(
      new Request("http://localhost/api/share-grants/missing", { method: "DELETE" })
    )

    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      error: "[SixbServer] Shared-access grant not found.",
    })
  })

  test("rejects malformed management inputs before calling the runtime", async () => {
    let calls = 0
    const app = createTestApp({
      issueById: async () => {
        calls += 1
        return { grant: activeGrant, secret: "unused" }
      },
      listById: async () => {
        calls += 1
        return { grants: [], total: 0, hasMore: false }
      },
      revoke: async () => {
        calls += 1
        return activeGrant
      },
    })

    const invalidRequests = [
      jsonRequest("/api/share-grants", "POST", {
        definitionId: "published-report",
        target: { objectTypeId: "Report", primaryId: "report-1" },
        destinationPath: "/reports/report-1",
        expiresAt: "tomorrow",
      }),
      new Request("http://localhost/api/share-grants"),
      new Request("http://localhost/api/share-grants?definitionId=published-report&primaryId=%20"),
      new Request("http://localhost/api/share-grants?definitionId=published-report&limit=201"),
      new Request("http://localhost/api/share-grants?definitionId=published-report&offset=1.5"),
      new Request("http://localhost/api/share-grants/%20", { method: "DELETE" }),
    ]

    for (const request of invalidRequests) {
      const response = await app.handle(request)
      expect(response.status).toBe(400)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect((await response.json()) as { error: string }).toHaveProperty("error")
    }
    expect(calls).toBe(0)
  })

  test("maps safe lifecycle errors and masks provider failures", async () => {
    const invalid = createTestApp({
      issueById: async () => {
        throw new ShareError("invalid_input", "[Sixb] Expiry must be in the future.")
      },
    })
    const invalidResponse = await invalid.handle(validIssueRequest())
    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toEqual({
      error: "[Sixb] Expiry must be in the future.",
    })

    const denied = createTestApp({
      listById: async () => {
        throw new AuthorizationError("share:manage:published-report", "Not allowed")
      },
    })
    const deniedResponse = await denied.handle(
      new Request("http://localhost/api/share-grants?definitionId=published-report")
    )
    expect(deniedResponse.status).toBe(403)
    expect(await deniedResponse.json()).toEqual({ error: "Not allowed" })

    for (const failure of [
      new ShareError("storage_failure", "postgres password=do-not-leak"),
      new Error("postgres password=do-not-leak"),
    ]) {
      const failed = createTestApp({
        issueById: async () => {
          throw failure
        },
      })
      const failedResponse = await failed.handle(validIssueRequest())
      expect(failedResponse.status).toBe(500)
      expect(failedResponse.headers.get("cache-control")).toBe("no-store")
      const body = await failedResponse.text()
      expect(body).toContain("[SixbServer] Shared-access operation failed.")
      expect(body).not.toContain("password")
    }

    const unavailable = createTestApp({
      listById: async () => {
        throw new ShareError("storage_unavailable", "internal provider topology")
      },
    })
    const unavailableResponse = await unavailable.handle(
      new Request("http://localhost/api/share-grants?definitionId=published-report")
    )
    expect(unavailableResponse.status).toBe(501)
    expect(await unavailableResponse.json()).toEqual({
      error: "[SixbServer] Shared-access grant storage is not configured on this runtime.",
    })
  })

  test("registers the lifecycle as bearer-capable with CSRF only for session mutations", () => {
    const requests = {
      issue: new Request("http://localhost/api/share-grants", { method: "POST" }),
      list: new Request("http://localhost/api/share-grants?definitionId=published-report"),
      revoke: new Request("http://localhost/api/share-grants/shr_1", { method: "DELETE" }),
    }

    expect(isAccessTokenRoute(requests.issue)).toBe(true)
    expect(isAccessTokenRoute(requests.list)).toBe(true)
    expect(isAccessTokenRoute(requests.revoke)).toBe(true)
    expect(shouldVerifyCsrfForAuthSource(classifyRoute(requests.issue), "session")).toBe(true)
    expect(shouldVerifyCsrfForAuthSource(classifyRoute(requests.revoke), "session")).toBe(true)
    expect(shouldVerifyCsrfForAuthSource(classifyRoute(requests.list), "session")).toBe(false)
    expect(shouldVerifyCsrfForAuthSource(classifyRoute(requests.issue), "accessToken")).toBe(false)
    expect(shouldVerifyCsrfForAuthSource(classifyRoute(requests.revoke), "accessToken")).toBe(false)
  })
})

function createTestApp(overrides: Partial<SharesRuntime>) {
  const shares = overrides as SharesRuntime
  const app = new Elysia()
  app.derive(() => ({ sixb: { shares } }))
  return registerShareGrantRoutes(app, {} as SixbHostView)
}

function validIssueRequest(): Request {
  return jsonRequest("/api/share-grants", "POST", {
    definitionId: "published-report",
    target: { objectTypeId: "Report", primaryId: "report-1" },
    destinationPath: "/reports/report-1",
    expiresAt: expiresAt.toISOString(),
  })
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function serializedGrant(grant: SharedAccessGrant) {
  return {
    id: grant.id,
    definitionId: grant.definitionId,
    target: grant.target,
    issuedBy: grant.issuedBy,
    destinationPath: grant.destinationPath,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt.toISOString() }),
    ...(grant.revokedBy === undefined ? {} : { revokedBy: grant.revokedBy }),
  }
}
