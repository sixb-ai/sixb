import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShareType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Report = defineObjectType({
  id: "shared-report",
  name: "Shared report",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const PublishedReport = defineShareType({
  id: "shared-published-report",
  target: Report,
  grants: [can.view(Report)],
})
const publishers = defineGroup("shared-publishers")
const publisher = defineRole("shared-publisher", {
  grantedTo: [publishers],
  grants: [can.view(Report), can.share(PublishedReport)],
})

describe("shared access routes", () => {
  test("exchanges a link without inheriting the ambient OIDC session", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture)

    const exchanged = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invitation.grantId}/exchange`, {
        method: "POST",
        headers: {
          cookie: fixture.normalSession.read.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ secret: invitation.secret }),
      })
    )
    const context = (await exchanged.json()) as {
      authenticated: true
      csrfToken: string
      grant: { id: string; issuedBy?: unknown; tokenDigest?: unknown }
      session: { expiresAt: string; id?: unknown }
    }

    expect(exchanged.status).toBe(200)
    expect(context).toMatchObject({
      authenticated: true,
      grant: { id: invitation.grantId },
    })
    expect(context.grant.issuedBy).toBeUndefined()
    expect(context.grant.tokenDigest).toBeUndefined()
    expect(context.session.id).toBeUndefined()
    expect(exchanged.headers.get("cache-control")).toBe("no-store")
    expect(exchanged.headers.get("referrer-policy")).toBe("no-referrer")
    expect(exchanged.headers.get("x-robots-tag")).toBe("noindex, nofollow")

    const setCookies = getSetCookies(exchanged)
    expect(setCookies).toEqual([
      expect.stringContaining("sixb_shared_session=shs_"),
      expect.stringContaining("sixb_shared_csrf="),
    ])
    expect(setCookies[0]).toContain(`Path=/api/shares/${invitation.grantId}`)
    expect(setCookies[0]).toContain("HttpOnly")
    expect(setCookies[0]).toContain("SameSite=Strict")
    expect(setCookies[1]).not.toContain("HttpOnly")

    const sharedCookies = requestCookieHeader(setCookies)
    const current = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invitation.grantId}/session`, {
        headers: { cookie: `${sharedCookies}; ${fixture.normalSession.read.cookie}` },
      })
    )
    expect(current.status).toBe(200)
    expect(await current.json()).toMatchObject({
      authenticated: true,
      session: { expiresAt: context.session.expiresAt },
    })

    const ambientOnly = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invitation.grantId}/session`, {
        headers: fixture.normalSession.read,
      })
    )
    expect(await ambientOnly.json()).toEqual({ authenticated: false })

    const normalApi = await fixture.app.fetch(
      new Request("http://api.localhost/api/objects", {
        headers: { cookie: sharedCookies },
      })
    )
    expect(normalApi.status).toBe(401)
  })

  test("returns one generic error for invalid link credentials", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture)
    const wrongSecret = "A".repeat(43)

    const invalid = await exchange(fixture, invitation.grantId, wrongSecret)
    const unknown = await exchange(fixture, "shr_unknown", wrongSecret)
    const revocation = await fixture.app.fetch(
      new Request(`http://api.localhost/api/share-grants/${invitation.grantId}`, {
        method: "DELETE",
        headers: fixture.normalSession.write,
      })
    )
    expect(revocation.status).toBe(200)
    const revoked = await exchange(fixture, invitation.grantId, invitation.secret)

    const unavailable = {
      error: "Shared access is unavailable.",
      code: "share.access_unavailable",
    }
    for (const response of [invalid, unknown, revoked]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(unavailable)
    }
    expect(invalid.headers.get("set-cookie")).toBeNull()
  })

  test("keeps malformed shared requests generic and applies the shared security headers", async () => {
    const fixture = await createFixture()
    const malformedSecret = "credential-that-must-not-be-reflected"
    const malformed = await fixture.app.fetch(
      new Request("http://api.localhost/api/shares/shr_1/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: malformedSecret }),
      })
    )
    const invalidJson = await fixture.app.fetch(
      new Request("http://api.localhost/api/shares/shr_1/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"secret":',
      })
    )

    for (const response of [malformed, invalidJson]) {
      const text = await response.text()
      expect(response.status).toBe(401)
      expect(JSON.parse(text)).toEqual({
        error: "Shared access is unavailable.",
        code: "share.access_unavailable",
      })
      expect(text).not.toContain(malformedSecret)
      expectSharedSecurityHeaders(response)
    }

    const invalidGrantId = "x".repeat(201)
    const session = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invalidGrantId}/session`)
    )
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual({ authenticated: false })
    expectSharedSecurityHeaders(session)

    const signOut = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invalidGrantId}/sign-out`, {
        method: "POST",
      })
    )
    expect(signOut.status).toBe(200)
    expect(await signOut.json()).toEqual({ signedOut: true })
    expectSharedSecurityHeaders(signOut)
  })

  test("does not expose unexpected protocol failures on any shared route", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture)
    const exchanged = await exchange(fixture, invitation.grantId, invitation.secret)
    const exchangedBody = (await exchanged.json()) as { csrfToken: string }
    const cookies = requestCookieHeader(getSetCookies(exchanged))

    Object.defineProperty(fixture.storage.shareGrants, "get", {
      value: async () => {
        throw new Error("postgres://private-host/provider-secret")
      },
    })

    const responses = await Promise.all([
      exchange(fixture, invitation.grantId, invitation.secret),
      fixture.app.fetch(
        new Request(`http://api.localhost/api/shares/${invitation.grantId}/session`, {
          headers: { cookie: cookies },
        })
      ),
      fixture.app.fetch(
        new Request(`http://api.localhost/api/shares/${invitation.grantId}/sign-out`, {
          method: "POST",
          headers: { cookie: cookies, "x-sixb-csrf": exchangedBody.csrfToken },
        })
      ),
    ])

    for (const response of responses) {
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: "An unexpected internal error occurred.",
        code: "internal.unexpected",
      })
      expect(response.headers.get("set-cookie")).toBeNull()
    }
  })

  test("requires shared CSRF for sign-out and invalidates the session", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture)
    const exchanged = await exchange(fixture, invitation.grantId, invitation.secret)
    const body = (await exchanged.json()) as { csrfToken: string }
    const cookies = requestCookieHeader(getSetCookies(exchanged))
    const signOutUrl = `http://api.localhost/api/shares/${invitation.grantId}/sign-out`

    const missingCsrf = await fixture.app.fetch(
      new Request(signOutUrl, { method: "POST", headers: { cookie: cookies } })
    )
    expect(missingCsrf.status).toBe(403)

    const signedOut = await fixture.app.fetch(
      new Request(signOutUrl, {
        method: "POST",
        headers: { cookie: cookies, "x-sixb-csrf": body.csrfToken },
      })
    )
    expect(signedOut.status).toBe(200)
    expect(await signedOut.json()).toEqual({ signedOut: true })
    expect(getSetCookies(signedOut).every((cookie) => cookie.includes("Max-Age=0"))).toBe(true)

    const current = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invitation.grantId}/session`, {
        headers: { cookie: cookies },
      })
    )
    expect(await current.json()).toEqual({ authenticated: false })
  })

  test("rechecks grant revocation on every shared request", async () => {
    const fixture = await createFixture()
    const invitation = await issueGrant(fixture)
    const exchanged = await exchange(fixture, invitation.grantId, invitation.secret)
    const cookies = requestCookieHeader(getSetCookies(exchanged))

    const revoked = await fixture.app.fetch(
      new Request(`http://api.localhost/api/share-grants/${invitation.grantId}`, {
        method: "DELETE",
        headers: fixture.normalSession.write,
      })
    )
    expect(revoked.status).toBe(200)

    const current = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shares/${invitation.grantId}/session`, {
        headers: { cookie: cookies },
      })
    )
    expect(await current.json()).toEqual({ authenticated: false })
    expect(getSetCookies(current).every((cookie) => cookie.includes("Max-Age=0"))).toBe(true)
  })
})

async function createFixture() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: "shared-project",
    ontology: [Report],
    shares: [PublishedReport],
    groups: [publishers],
    roles: [publisher],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" as const },
  })
  await createTestSixb(host).objects.upsert(Report.id, { id: "report-1" })
  const normalSession = await seedSession(storage)
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: createTestBrowserPolicy(),
    })
  )
  return { app, storage, normalSession }
}

async function seedSession(storage: InMemoryStorage) {
  const credential = createSessionCredential("ses_shared_publisher")
  await storage.auth.users.create({
    id: "usr_shared_publisher",
    projectId: "shared-project",
    email: "publisher@shared.test",
  })
  await storage.auth.groupMemberships.upsert({
    projectId: "shared-project",
    userId: "usr_shared_publisher",
    groupId: publishers.id,
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "shared-project",
    userId: "usr_shared_publisher",
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-08-20T12:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  })
  return {
    read: { cookie: `sixb_session=${credential.cookieValue}` },
    write: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_shared`,
      "x-sixb-csrf": "csrf_shared",
      "content-type": "application/json",
    },
  }
}

async function issueGrant(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const issued = await fixture.app.fetch(
    new Request("http://api.localhost/api/share-grants", {
      method: "POST",
      headers: fixture.normalSession.write,
      body: JSON.stringify({
        shareTypeId: PublishedReport.id,
        target: { objectTypeId: Report.id, primaryId: "report-1" },
        expiresAt: "2098-01-01T00:00:00.000Z",
      }),
    })
  )
  expect(issued.status).toBe(201)
  const body = (await issued.json()) as { grant: { id: string }; url: string }
  return { grantId: body.grant.id, secret: new URL(body.url).hash.slice(1) }
}

function exchange(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  grantId: string,
  secret: string
) {
  return fixture.app.fetch(
    new Request(`http://api.localhost/api/shares/${grantId}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    })
  )
}

function getSetCookies(response: Response): string[] {
  return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
}

function requestCookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((cookie) => cookie.slice(0, cookie.indexOf(";"))).join("; ")
}

function expectSharedSecurityHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'"
  )
  expect(response.headers.get("referrer-policy")).toBe("no-referrer")
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
}
