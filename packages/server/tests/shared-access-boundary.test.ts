import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  objectRef,
  prop,
  resolveAuthorizationContext,
  type SharesRuntime,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { SHARED_ACCESS_GRANT_HEADER_NAME, sharedAccessCookieNames } from "../src/auth/shared-access"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Report = defineObjectType({
  id: "shared-report",
  name: "Shared report",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("attachment", "fileRef"),
  ],
})

const PublishedReport = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target)],
})

const publishers = defineGroup("shared-publishers")
const broadReaders = defineGroup("shared-broad-readers")
const publisher = defineRole("shared.publisher", {
  grantedTo: [publishers],
  grants: [can.view(Report), can.share(PublishedReport)],
})
const broadReader = defineRole("shared.broad-reader", {
  grantedTo: [broadReaders],
  grants: [can.view(Report)],
})

describe("shared-access request boundary", () => {
  test("binds only shared authority and never falls back to ambient or bearer auth", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    const exchanged = await exchange(fixture, invitation, {
      cookie: fixture.ambient.cookie,
    })
    const body = await sharedSessionBody(exchanged)

    expect(exchanged.status).toBe(200)
    expect(body).toEqual({
      grantId: invitation.grant.id,
      destinationPath: "/reports/report-1",
      expiresAt: expect.any(String),
      absoluteExpiresAt: invitation.grant.expiresAt.toISOString(),
      csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    })
    expect(Object.keys(body).sort()).toEqual([
      "absoluteExpiresAt",
      "csrfToken",
      "destinationPath",
      "expiresAt",
      "grantId",
    ])
    expect(exchanged.headers.get("x-sixb-csrf-token")).toBe(body.csrfToken)

    const names = sharedAccessCookieNames(invitation.grant.id)
    const setCookies = getSetCookies(exchanged)
    expect(names.session).toEndWith(createHash("sha256").update(invitation.grant.id).digest("hex"))
    expect(setCookies).toEqual([
      expect.stringContaining(`${names.session}=`),
      expect.stringContaining(`${names.csrf}=`),
    ])
    expect(setCookies[0]).toContain("Path=/api")
    expect(setCookies[0]).toContain("SameSite=Strict")
    expect(setCookies[0]).toContain("HttpOnly")
    expect(setCookies[0]).not.toContain("Domain=")
    expect(setCookies[1]).not.toContain("HttpOnly")

    const sharedCookies = requestCookieHeader(setCookies)
    const selectedHeaders = {
      cookie: `${sharedCookies}; ${fixture.ambient.cookie}`,
      [SHARED_ACCESS_GRANT_HEADER_NAME]: invitation.grant.id,
    }

    const target = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-1", {
        headers: selectedHeaders,
      })
    )
    expect(target.status).toBe(200)
    expect(target.headers.get("cache-control")).toBe("no-store")
    expect(getSetCookies(target)).toEqual([])

    const foreground = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-1", {
        headers: { ...selectedHeaders, "x-sixb-session-activity": "1" },
      })
    )
    expect(foreground.status).toBe(200)
    expect(getSetCookies(foreground)).toHaveLength(2)

    const other = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-2", {
        headers: selectedHeaders,
      })
    )
    expect(other.status).toBe(404)
    expect(other.headers.get("cache-control")).toBe("no-store")

    // The ambient principal can read this object, proving it was not merged into the shared scope.
    const ambient = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-2", {
        headers: { cookie: fixture.ambient.cookie },
      })
    )
    expect(ambient.status).toBe(200)

    const noSharedCookie = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-1", {
        headers: {
          cookie: fixture.ambient.cookie,
          origin: "http://atlas.localhost",
          [SHARED_ACCESS_GRANT_HEADER_NAME]: invitation.grant.id,
        },
      })
    )
    expect(noSharedCookie.status).toBe(401)
    expect(noSharedCookie.headers.get("access-control-allow-origin")).toBe("http://atlas.localhost")
    expect(await noSharedCookie.json()).toEqual({ error: "Shared access session is invalid" })

    const emptySelector = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-1", {
        headers: { cookie: fixture.ambient.cookie, [SHARED_ACCESS_GRANT_HEADER_NAME]: "" },
      })
    )
    expect(emptySelector.status).toBe(401)

    const invalidSessionBeforeParsing = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/query", {
        method: "POST",
        headers: {
          cookie: fixture.ambient.cookie,
          "content-type": "application/json",
          [SHARED_ACCESS_GRANT_HEADER_NAME]: invitation.grant.id,
        },
        body: '{"query":',
      })
    )
    expect(invalidSessionBeforeParsing.status).toBe(401)
    expect(await invalidSessionBeforeParsing.json()).toEqual({
      error: "Shared access session is invalid",
    })

    const bearerCollision = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/shared-report/report-1", {
        headers: {
          ...selectedHeaders,
          authorization: "Bearer deliberately-not-valid",
        },
      })
    )
    expect(bearerCollision.status).toBe(403)
    expect(await bearerCollision.json()).toEqual({
      error: "Shared access is not allowed for this request",
    })

    const unsupported = await fixture.app.fetch(
      new Request("http://api.localhost/api/project", { headers: selectedHeaders })
    )
    expect(unsupported.status).toBe(403)
    expect(await unsupported.json()).toEqual({
      error: "Shared access is not allowed for this request",
    })

    for (const [method, path] of [
      ["POST", "/api/files"],
      ["PUT", "/api/objects/shared-report/report-1"],
      ["GET", "/api/action-runs/run-1/files/content"],
      ["HEAD", "/api/action-runs/run-1/files/content"],
      ["GET", "/ws/events"],
    ] as const) {
      const denied = await fixture.app.fetch(
        new Request(`http://api.localhost${path}`, { method, headers: selectedHeaders })
      )
      expect(denied.status, `${method} ${path}`).toBe(403)
    }
  })

  test("isolates concurrent grants with grant-derived cookie names", async () => {
    const fixture = await createFixture()
    const first = await issueGrant(fixture, "report-1")
    const second = await issueGrant(fixture, "report-2")
    const firstExchange = await exchange(fixture, first)
    const secondExchange = await exchange(fixture, second)
    const firstCookies = getSetCookies(firstExchange)
    const secondCookies = getSetCookies(secondExchange)
    const firstNames = sharedAccessCookieNames(first.grant.id)
    const secondNames = sharedAccessCookieNames(second.grant.id)

    expect(firstNames).not.toEqual(secondNames)
    expect(firstCookies[0]).toContain(`${firstNames.session}=`)
    expect(secondCookies[0]).toContain(`${secondNames.session}=`)

    const secureExchange = await fixture.app.fetch(
      new Request(`https://api.example.test/api/shared-access/${first.grant.id}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: first.secret }),
      })
    )
    expect(getSetCookies(secureExchange).every((cookie) => cookie.includes("Secure"))).toBe(true)

    const combinedCookies = requestCookieHeader([...firstCookies, ...secondCookies])
    const firstTarget = await getObject(fixture, "report-1", first.grant.id, combinedCookies)
    const firstOther = await getObject(fixture, "report-2", first.grant.id, combinedCookies)
    const secondTarget = await getObject(fixture, "report-2", second.grant.id, combinedCookies)

    expect(firstTarget.status).toBe(200)
    expect(firstOther.status).toBe(404)
    expect(secondTarget.status).toBe(200)
  })

  test("never caches shared file GET or HEAD responses", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    const exchanged = await exchange(fixture, invitation)
    const sharedCookies = requestCookieHeader(getSetCookies(exchanged))
    const path = "/api/objects/shared-report/report-1/files/content?path=/properties/attachment"

    for (const method of ["GET", "HEAD"] as const) {
      const shared = await fixture.app.fetch(
        new Request(`http://api.localhost${path}`, {
          method,
          headers: {
            cookie: sharedCookies,
            [SHARED_ACCESS_GRANT_HEADER_NAME]: invitation.grant.id,
          },
        })
      )
      expect(shared.status, method).toBe(200)
      // Regression proof: remove the explicit Response rewrite in the shared mapResponse boundary;
      // Elysia then preserves the file helper's one-year immutable cache header and this fails.
      expect(shared.headers.get("cache-control"), method).toBe("no-store")
      if (method === "GET") expect(await shared.text()).toBe("shared attachment")

      const principal = await fixture.app.fetch(
        new Request(`http://api.localhost${path}`, {
          method,
          headers: { cookie: fixture.ambient.cookie },
        })
      )
      expect(principal.status, method).toBe(200)
      expect(principal.headers.get("cache-control"), method).toBe(
        "private, max-age=31536000, immutable"
      )
      if (method === "GET") expect(await principal.text()).toBe("shared attachment")
    }
  })

  test("uses dedicated shared CSRF for POST reads and sign-out", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    const exchanged = await exchange(fixture, invitation)
    const body = await sharedSessionBody(exchanged)
    const otherInvitation = await issueGrant(fixture, "report-2")
    const otherBody = await sharedSessionBody(await exchange(fixture, otherInvitation))
    expect(otherBody.csrfToken).not.toBe(body.csrfToken)
    const sharedCookies = requestCookieHeader(getSetCookies(exchanged))
    const cookies = `${sharedCookies}; ${fixture.ambient.cookie}; sixb_csrf=normal-csrf`
    const queryBody = JSON.stringify({
      query: { kind: "start", objectTypeId: Report.id },
    })
    const baseHeaders = {
      cookie: cookies,
      "content-type": "application/json",
      [SHARED_ACCESS_GRANT_HEADER_NAME]: invitation.grant.id,
    }

    const normalCsrf = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/query", {
        method: "POST",
        headers: { ...baseHeaders, "x-sixb-csrf": "normal-csrf" },
        body: queryBody,
      })
    )
    expect(normalCsrf.status).toBe(403)

    const actionWithoutCsrf = await fixture.app.fetch(
      new Request("http://api.localhost/api/actions/not-granted", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({ params: {} }),
      })
    )
    expect(actionWithoutCsrf.status).toBe(403)
    expect(await actionWithoutCsrf.json()).toEqual({
      error: "Shared access is not allowed for this request",
    })

    const wrongSharedCsrf = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/query", {
        method: "POST",
        headers: { ...baseHeaders, "x-sixb-csrf": otherBody.csrfToken },
        body: queryBody,
      })
    )
    expect(wrongSharedCsrf.status).toBe(403)

    const allowed = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/query", {
        method: "POST",
        headers: {
          ...baseHeaders,
          "x-sixb-csrf": body.csrfToken,
        },
        body: queryBody,
      })
    )
    expect(allowed.status).toBe(200)
    const allowedBody = (await allowed.json()) as { objects: readonly { primaryId: string }[] }
    expect(allowedBody.objects.map((object) => object.primaryId)).toEqual(["report-1"])

    const malformedCanonicalBody = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects/query", {
        method: "POST",
        headers: { ...baseHeaders, "x-sixb-csrf": body.csrfToken },
        body: '{"query":',
      })
    )
    expect(malformedCanonicalBody.status).toBeGreaterThanOrEqual(400)
    expect(malformedCanonicalBody.headers.get("cache-control")).toBe("no-store")

    const signOutUrl = `http://api.localhost/api/shared-access/${invitation.grant.id}/sign-out`
    const normalSignOut = await fixture.app.fetch(
      new Request(signOutUrl, {
        method: "POST",
        headers: { cookie: cookies, "x-sixb-csrf": "normal-csrf" },
      })
    )
    expect(normalSignOut.status).toBe(403)

    const signedOut = await fixture.app.fetch(
      new Request(signOutUrl, {
        method: "POST",
        headers: {
          cookie: cookies,
          "x-sixb-csrf": body.csrfToken,
        },
      })
    )
    expect(signedOut.status).toBe(200)
    expect(await signedOut.json()).toEqual({ signedOut: true })
    expect(getSetCookies(signedOut).every((cookie) => cookie.includes("Max-Age=0"))).toBe(true)
    expect(getSetCookies(signedOut).every((cookie) => cookie.includes("Path=/api"))).toBe(true)

    const afterSignOut = await getObject(fixture, "report-1", invitation.grant.id, sharedCookies)
    expect(afterSignOut.status).toBe(401)
  })

  test("keeps invalid, unknown, revoked, and malformed link credentials indistinguishable", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    const wrongSecret = "A".repeat(43)
    const invalid = await exchange(fixture, { ...invitation, secret: wrongSecret })
    const unknown = await exchange(fixture, {
      ...invitation,
      grant: { ...invitation.grant, id: "shr_unknown" },
      secret: wrongSecret,
    })
    await fixture.issuer.shares.revoke(invitation.grant.id)
    const revoked = await exchange(fixture, invitation)
    const malformed = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shared-access/${invitation.grant.id}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "must-not-be-reflected" }),
      })
    )

    for (const response of [invalid, unknown, revoked, malformed]) {
      const text = await response.text()
      expect(response.status).toBe(401)
      expect(JSON.parse(text)).toEqual({ error: "Shared access session is invalid" })
      expect(text).not.toContain("must-not-be-reflected")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  test("masks storage failures at both the lifecycle and canonical boundaries", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    const exchanged = await exchange(fixture, invitation)
    const cookies = requestCookieHeader(getSetCookies(exchanged))

    const sessions = fixture.storage.shareSessions
    if (!sessions) throw new Error("Expected in-memory shared-session storage")
    Object.defineProperty(sessions, "getById", {
      value: async () => {
        throw new Error("postgres://private-host/password=must-not-leak")
      },
    })

    const lifecycle = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shared-access/${invitation.grant.id}/session`, {
        headers: { cookie: cookies },
      })
    )
    const canonical = await getObject(fixture, "report-1", invitation.grant.id, cookies)

    for (const response of [lifecycle, canonical]) {
      const text = await response.text()
      expect(response.status).toBe(503)
      expect(JSON.parse(text)).toEqual({ error: "Shared access is unavailable" })
      expect(text).not.toContain("password")
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
  })

  test("reports missing shared-session storage as unavailable, not bad credentials", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture, "report-1")
    Object.defineProperty(fixture.storage, "shareSessions", { value: undefined })

    const response = await exchange(fixture, invitation)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "Shared access is unavailable" })
  })
})

async function createFixture() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: "shared-boundary-tests",
    ontology: [Report],
    shares: [PublishedReport],
    groups: [publishers, broadReaders],
    roles: [publisher, broadReader],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" as const },
  })
  const attachment = await blobStorage.put({
    body: new TextEncoder().encode("shared attachment"),
    fileName: "attachment.txt",
    mediaType: "text/plain",
  })
  await createTestSixb(host)
    .objects(Report)
    .upsert({
      properties: { id: "report-1", name: "First", attachment },
    })
  await createTestSixb(host)
    .objects(Report)
    .upsert({
      properties: { id: "report-2", name: "Second" },
    })
  const issuer = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_publisher" },
      groupIds: [publishers.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  const ambient = await seedAmbientSession(storage)
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  return { app, host, storage, issuer, ambient }
}

async function seedAmbientSession(storage: InMemoryStorage) {
  const credential = createSessionCredential("ses_ambient_reader")
  await storage.auth.users.create({
    id: "usr_ambient_reader",
    projectId: "shared-boundary-tests",
    email: "ambient@shared.test",
  })
  await storage.auth.groupMemberships.upsert({
    projectId: "shared-boundary-tests",
    userId: "usr_ambient_reader",
    groupId: broadReaders.id,
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "shared-boundary-tests",
    userId: "usr_ambient_reader",
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  })
  return { cookie: `sixb_session=${credential.cookieValue}` }
}

interface SharedAccessFixtureSlice {
  readonly app: { fetch(request: Request): Response | Promise<Response> }
  readonly issuer: { readonly shares: SharesRuntime }
}

async function issueGrant(fixture: SharedAccessFixtureSlice, primaryId: string) {
  return fixture.issuer.shares.issue(PublishedReport, {
    target: objectRef(Report, primaryId),
    destinationPath: `/reports/${primaryId}`,
    expiresAt: new Date("2098-01-01T00:00:00.000Z"),
  })
}

function exchange(
  fixture: SharedAccessFixtureSlice,
  invitation: Awaited<ReturnType<typeof issueGrant>>,
  headers: Record<string, string> = {}
) {
  return fixture.app.fetch(
    new Request(`http://api.localhost/api/shared-access/${invitation.grant.id}/exchange`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ secret: invitation.secret }),
    })
  )
}

function getObject(
  fixture: SharedAccessFixtureSlice,
  primaryId: string,
  grantId: string,
  cookies: string
) {
  return fixture.app.fetch(
    new Request(`http://api.localhost/api/objects/${Report.id}/${primaryId}`, {
      headers: {
        cookie: cookies,
        [SHARED_ACCESS_GRANT_HEADER_NAME]: grantId,
      },
    })
  )
}

function getSetCookies(response: Response): string[] {
  return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
}

function requestCookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((cookie) => cookie.slice(0, cookie.indexOf(";"))).join("; ")
}

async function sharedSessionBody(response: Response): Promise<{
  readonly grantId: string
  readonly destinationPath: string
  readonly expiresAt: string
  readonly absoluteExpiresAt: string
  readonly csrfToken: string
}> {
  return (await response.json()) as {
    grantId: string
    destinationPath: string
    expiresAt: string
    absoluteExpiresAt: string
    csrfToken: string
  }
}
