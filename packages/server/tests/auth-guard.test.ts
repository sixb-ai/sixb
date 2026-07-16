import { describe, expect, setSystemTime, test } from "bun:test"
import { createServer } from "node:net"
import {
  type AuthCookieOptions,
  type AuthSessionOptions,
  applications,
  can,
  createAccessTokenCredential,
  createSessionCredential,
  defineConnector,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWebhook,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  type RoleDefinition,
  Sixb,
} from "@sixb/core"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../src/auth/csrf"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const securityAdmins = defineGroup("security-admins")
const atlasUsers = defineGroup("atlas-users")

const authStrategy = {
  id: "test",
  kind: "dev" as const,
}

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}

function createRuntime(
  options: {
    readonly auth?: boolean
    readonly connector?: boolean
    readonly cookies?: AuthCookieOptions
    readonly roles?: readonly RoleDefinition[]
    readonly session?: AuthSessionOptions
  } = {}
) {
  const storage = new InMemoryStorage()
  const connector = defineConnector("github", {
    type: "test",
    webhooks: [
      defineWebhook("events")
        .post()
        .json()
        .verify(() => {
          throw new Error("bad signature")
        })
        .handle(() => {}),
    ],
    connect() {
      return {}
    },
  })

  const sixb = new Sixb<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors: options.connector ? [connector] : [],
    groups: [securityAdmins, atlasUsers],
    roles: options.roles,
    auth: options.auth
      ? options.session || options.cookies
        ? {
            strategy: authStrategy,
            ...(options.session ? { session: options.session } : {}),
            ...(options.cookies ? { cookies: options.cookies } : {}),
          }
        : authStrategy
      : undefined,
  })

  return { sixb, storage }
}

async function seedSession(
  storage: InMemoryStorage,
  params: {
    readonly audience?: "atlas" | "app"
    readonly status?: "active" | "suspended"
    readonly createdAt?: Date
    readonly expiresAt?: Date
    readonly absoluteExpiresAt?: Date
  } = {}
) {
  const credential = createSessionCredential("ses_1")
  const audience = params.audience ?? "atlas"
  const cookieSuffix = audience === "atlas" ? "" : `_${audience}`
  await storage.auth.users.create({
    id: "usr_1",
    projectId: "test-project",
    email: "ava@acme.com",
    displayName: "Ava Chen",
    status: params.status,
  })
  await storage.auth.groupMemberships.upsert({
    projectId: "test-project",
    userId: "usr_1",
    groupId: "security-admins",
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId: "usr_1",
    strategyId: "test",
    audience,
    tokenHash: credential.tokenHash,
    createdAt: params.createdAt ?? new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: params.expiresAt ?? new Date("2099-05-16T10:00:00.000Z"),
    absoluteExpiresAt: params.absoluteExpiresAt,
  })

  return {
    credential,
    cookie: `sixb_session${cookieSuffix}=${credential.cookieValue}`,
    csrfCookie: `sixb_csrf${cookieSuffix}=csrf_1`,
    csrfHeader: { "x-sixb-csrf": "csrf_1" },
  }
}

function getSetCookies(response: Response): string[] {
  return (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
}

async function seedAccessToken(storage: InMemoryStorage) {
  const credential = createAccessTokenCredential("personal", "tok_server")
  await storage.auth.users.create({
    id: "usr_token",
    projectId: "test-project",
    email: "token@acme.com",
  })
  await storage.auth.accessTokens.create({
    id: credential.tokenId,
    projectId: "test-project",
    name: "Server test token",
    kind: "personal",
    subjectType: "user",
    subjectId: "usr_token",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return credential
}

describe("server auth guard", () => {
  test("leaves routes open when auth is not configured outside production", async () => {
    const { sixb } = createRuntime()
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(new Request("http://localhost/api/project"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "test-project" })
  })

  test("fails closed in production when auth is missing", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"

    try {
      const { sixb } = createRuntime()
      expect(() =>
        createSixbApi(new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() }))
      ).toThrow("Auth is required in production")
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })

  test("maps each auth audience to exactly one browser origin", () => {
    const { sixb } = createRuntime({ auth: true })

    expect(
      () =>
        new SixbServer({
          sixb,
          quiet: true,
          browser: {
            allowedOrigins: [
              { origin: "http://atlas.localhost", audience: "atlas" },
              { origin: "http://admin.localhost", audience: "atlas" },
            ],
          },
        })
    ).toThrow("Auth audience 'atlas' is mapped to multiple browser origins")
  })

  test("protects API routes with generic JSON 401", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(new Request("http://localhost/api/project"))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Authentication required" })
  })

  test("accepts bearer tokens only on the access token route boundary", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const credential = await seedAccessToken(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )
    const headers = {
      authorization: `Bearer ${credential.tokenValue}`,
      "x-sixb-session-activity": "1",
    }

    const accepted = await app.fetch(
      new Request("http://localhost/api/project", {
        headers,
      })
    )
    const acceptedTelemetryRead = await app.fetch(
      new Request("http://localhost/api/objects/device/fan-1/telemetry/rpm/latest", {
        headers,
      })
    )
    const acceptedActionRunDetail = await app.fetch(
      new Request("http://localhost/api/action-runs/act_run_1", {
        headers,
      })
    )
    const rejectedAuthManagement = await app.fetch(
      new Request("http://localhost/api/auth/sessions", {
        headers,
      })
    )
    const rejectedRawWrite = await app.fetch(
      new Request("http://localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ properties: { name: "Fan 1" } }),
      })
    )

    expect(accepted.status).toBe(200)
    expect(getSetCookies(accepted)).toEqual([])
    expect(await accepted.json()).toEqual({ id: "test-project" })
    expect(acceptedTelemetryRead.status).toBe(404)
    expect(acceptedActionRunDetail.status).toBe(404)
    expect(rejectedAuthManagement.status).toBe(403)
    expect(rejectedRawWrite.status).toBe(403)
  })

  test("returns a safe session shape", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: seeded.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      csrfToken: expect.any(String),
      applicationAccess: { audience: "atlas", allowed: true },
      user: {
        id: "usr_1",
        email: "ava@acme.com",
        displayName: "Ava Chen",
        groupIds: ["security-admins"],
      },
      session: {
        id: "ses_1",
        expiresAt: "2099-05-16T10:00:00.000Z",
      },
    })
    expect(response.headers.get("set-cookie")).toContain("sixb_csrf=")
  })

  test("renews session and CSRF cookies on foreground protected requests", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const { sixb, storage } = createRuntime({
        auth: true,
        session: {
          idleTimeoutMs: 30 * 60_000,
          renewalWindowMs: 10 * 60_000,
          cacheTtlMs: 0,
        },
      })
      const seeded = await seedSession(storage, {
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const app = createSixbApi(
        new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
      )

      const response = await app.fetch(
        new Request("http://api.localhost/api/project", {
          headers: {
            origin: "http://atlas.localhost",
            cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
            "x-sixb-session-activity": "1",
          },
        })
      )

      expect(response.status).toBe(200)
      const cookies = getSetCookies(response)
      expect(cookies).toHaveLength(2)
      expect(cookies[0]).toContain(`sixb_session=${seeded.credential.cookieValue}`)
      expect(cookies[1]).toContain("sixb_csrf=csrf_1")
      expect(response.headers.get(CSRF_TOKEN_RESPONSE_HEADER_NAME)).toBe("csrf_1")
      expect(response.headers.get("access-control-expose-headers")).toContain(
        CSRF_TOKEN_RESPONSE_HEADER_NAME
      )
      for (const cookie of cookies) {
        expect(cookie).toContain("Max-Age=1800")
        expect(cookie).toContain("Expires=Wed, 01 Jul 2026 10:30:00 GMT")
      }
      await expect(
        storage.auth.sessions.getById({ projectId: "test-project", id: "ses_1" })
      ).resolves.toMatchObject({ expiresAt: new Date("2026-07-01T10:30:00.000Z") })
    } finally {
      setSystemTime()
    }
  })

  test("repairs a missing CSRF cookie during session renewal", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const { sixb, storage } = createRuntime({
        auth: true,
        session: {
          idleTimeoutMs: 30 * 60_000,
          renewalWindowMs: 10 * 60_000,
          cacheTtlMs: 0,
        },
      })
      const seeded = await seedSession(storage, {
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const app = createSixbApi(
        new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
      )

      const response = await app.fetch(
        new Request("http://localhost/api/project", {
          headers: {
            cookie: seeded.cookie,
            "x-sixb-session-activity": "1",
          },
        })
      )

      expect(response.status).toBe(200)
      const csrfCookie = getSetCookies(response).find((cookie) => cookie.startsWith("sixb_csrf="))
      const csrfToken = csrfCookie?.match(/^sixb_csrf=([^;]+)/)?.[1]
      if (!csrfToken) throw new Error("Expected the renewed CSRF cookie to contain a token")
      expect(response.headers.get(CSRF_TOKEN_RESPONSE_HEADER_NAME)).toBe(csrfToken)
    } finally {
      setSystemTime()
    }
  })

  test("does not renew cookies without foreground activity", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const { sixb, storage } = createRuntime({
        auth: true,
        session: {
          idleTimeoutMs: 30 * 60_000,
          renewalWindowMs: 10 * 60_000,
          cacheTtlMs: 0,
        },
      })
      const seeded = await seedSession(storage, {
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const app = createSixbApi(
        new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
      )

      const response = await app.fetch(
        new Request("http://localhost/api/project", {
          headers: { cookie: `${seeded.cookie}; ${seeded.csrfCookie}` },
        })
      )

      expect(response.status).toBe(200)
      expect(getSetCookies(response)).toEqual([])
    } finally {
      setSystemTime()
    }
  })

  test("renews cookies from the public session endpoint without duplicating CSRF", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const { sixb, storage } = createRuntime({
        auth: true,
        cookies: { csrfHttpOnly: true },
        session: {
          idleTimeoutMs: 30 * 60_000,
          renewalWindowMs: 10 * 60_000,
          cacheTtlMs: 0,
        },
      })
      const seeded = await seedSession(storage, {
        audience: "app",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const app = createSixbApi(
        new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
      )

      const response = await app.fetch(
        new Request("http://localhost/api/auth/session", {
          headers: {
            origin: "http://app.localhost",
            cookie: seeded.cookie,
            "x-sixb-session-activity": "1",
          },
        })
      )

      expect(response.status).toBe(200)
      const body = (await response.json()) as { readonly csrfToken: string }
      const { csrfToken } = body
      expect(body).toMatchObject({
        authenticated: true,
        csrfToken: expect.any(String),
        applicationAccess: { audience: "app" },
        session: { expiresAt: "2026-07-01T10:30:00.000Z" },
      })
      const cookies = getSetCookies(response)
      expect(cookies).toHaveLength(2)
      expect(cookies[0]).toContain(`sixb_session_app=${seeded.credential.cookieValue}`)
      expect(cookies[1]).toContain(`sixb_csrf_app=${csrfToken}`)
      expect(cookies[1]).toContain("HttpOnly")
      expect(response.headers.get(CSRF_TOKEN_RESPONSE_HEADER_NAME)).toBe(csrfToken)
    } finally {
      setSystemTime()
    }
  })

  test("application grants restrict Atlas at the session and API boundaries", async () => {
    const atlasAccess = defineRole("atlas.access", {
      grantedTo: [atlasUsers],
      grants: [can.access(applications.atlas)],
    })
    const { sixb, storage } = createRuntime({ auth: true, roles: [atlasAccess] })
    const atlasSession = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const deniedSession = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          origin: "http://atlas.localhost",
          cookie: atlasSession.cookie,
        },
      })
    )
    const deniedApi = await app.fetch(
      new Request("http://api.localhost/api/project", {
        headers: {
          origin: "http://atlas.localhost",
          cookie: atlasSession.cookie,
        },
      })
    )

    expect(deniedSession.status).toBe(200)
    expect(await deniedSession.json()).toMatchObject({
      authenticated: true,
      applicationAccess: { audience: "atlas", allowed: false },
    })
    expect(deniedApi.status).toBe(403)
    expect(await deniedApi.json()).toEqual({ error: "Application access is not allowed" })
  })

  test("application grants allow Atlas for a matching group", async () => {
    const atlasAccess = defineRole("atlas.access", {
      grantedTo: [securityAdmins],
      grants: [can.access(applications.atlas)],
    })
    const { sixb, storage } = createRuntime({ auth: true, roles: [atlasAccess] })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(
      new Request("http://api.localhost/api/project", {
        headers: {
          origin: "http://atlas.localhost",
          cookie: seeded.cookie,
        },
      })
    )

    expect(response.status).toBe(200)
  })

  test("resolves sessions with the app audience cookie names", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const accepted = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: { origin: "http://app.localhost", cookie: seeded.cookie },
      })
    )
    const adminCookie = await app.fetch(
      new Request("http://api.localhost/api/project", {
        headers: {
          origin: "http://app.localhost",
          cookie: `sixb_session=${seeded.credential.cookieValue}`,
        },
      })
    )

    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      authenticated: true,
      session: { id: "ses_1" },
    })
    expect(adminCookie.status).toBe(401)
  })

  test("resolves API browser sessions from the allowed origin audience", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    )

    const accepted = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          origin: "http://app.localhost",
          cookie: seeded.cookie,
        },
      })
    )
    const wrongCookieName = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          origin: "http://app.localhost",
          cookie: `sixb_session=${seeded.credential.cookieValue}`,
        },
      })
    )

    expect(accepted.status).toBe(200)
    expect(accepted.headers.get("access-control-allow-origin")).toBe("http://app.localhost")
    expect(accepted.headers.get("access-control-allow-credentials")).toBe("true")
    expect(accepted.headers.get("vary")).toBe("Origin")
    expect(await accepted.json()).toMatchObject({
      authenticated: true,
      csrfToken: expect.any(String),
      session: { id: "ses_1" },
    })
    expect(await wrongCookieName.json()).toEqual({ authenticated: false })
  })

  test("rejects API browser requests from unknown origins", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy({ includeApp: false }),
      })
    )

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: { origin: "http://evil.localhost" },
      })
    )

    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(await response.json()).toEqual({ error: "Browser origin is not allowed" })
  })

  test("handles API browser preflights with an exact origin allowlist", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy({ includeApp: false }),
      })
    )

    const allowed = await app.fetch(
      new Request("http://api.localhost/api/objects/device/fan-1", {
        method: "OPTIONS",
        headers: {
          origin: "http://atlas.localhost",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type,x-sixb-csrf,x-sixb-session-activity",
        },
      })
    )
    const rejected = await app.fetch(
      new Request("http://api.localhost/api/objects/device/fan-1", {
        method: "OPTIONS",
        headers: {
          origin: "http://evil.localhost",
          "access-control-request-method": "PUT",
        },
      })
    )

    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://atlas.localhost")
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true")
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-sixb-csrf, x-sixb-session-activity"
    )
    expect(rejected.status).toBe(403)
  })

  test("uses the browser origin audience for CSRF-protected API mutations", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
      })
    )

    const response = await app.fetch(
      new Request("http://api.localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: {
          origin: "http://app.localhost",
          "content-type": "application/json",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          ...seeded.csrfHeader,
        },
        body: JSON.stringify({ properties: { name: "Fan" } }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://app.localhost")
  })

  test("requires CSRF only after authentication for mutations", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )
    const body = JSON.stringify({ properties: { name: "Fan" } })

    const unauthenticated = await app.fetch(
      new Request("http://localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      })
    )
    const missingCsrf = await app.fetch(
      new Request("http://localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: seeded.cookie,
        },
        body,
      })
    )
    const accepted = await app.fetch(
      new Request("http://localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          ...seeded.csrfHeader,
        },
        body,
      })
    )

    expect(unauthenticated.status).toBe(401)
    expect(missingCsrf.status).toBe(403)
    expect(accepted.status).toBe(200)
  })

  test("does not emit renewal cookies for a denied mutation", async () => {
    const now = new Date("2026-07-01T10:00:00.000Z")
    setSystemTime(now)
    try {
      const { sixb, storage } = createRuntime({
        auth: true,
        session: {
          idleTimeoutMs: 30 * 60_000,
          renewalWindowMs: 10 * 60_000,
          cacheTtlMs: 0,
        },
      })
      const seeded = await seedSession(storage, {
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
      })
      const app = createSixbApi(
        new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
      )

      const response = await app.fetch(
        new Request("http://localhost/api/objects/device/fan-1", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: seeded.cookie,
            "x-sixb-session-activity": "1",
          },
          body: JSON.stringify({ properties: { name: "Fan" } }),
        })
      )

      expect(response.status).toBe(403)
      expect(getSetCookies(response)).toEqual([])
      await expect(
        storage.auth.sessions.getById({ projectId: "test-project", id: "ses_1" })
      ).resolves.toMatchObject({ expiresAt: new Date("2026-07-01T10:05:00.000Z") })
    } finally {
      setSystemTime()
    }
  })

  test("sign-out revokes the session and clears cookies", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          ...seeded.csrfHeader,
          "x-sixb-session-activity": "1",
        },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(response.headers.get("set-cookie")).toContain("sixb_session=")
    expect(getSetCookies(response)).toHaveLength(2)
    for (const cookie of getSetCookies(response)) expect(cookie).toContain("Max-Age=0")
    await expect(
      storage.auth.sessions.getById({ projectId: "test-project", id: "ses_1" })
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    })
  })

  test("keeps webhooks public while connector verification remains authoritative", async () => {
    const { sixb } = createRuntime({ auth: true, connector: true })
    const app = createSixbApi(
      new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
    )

    const response = await app.fetch(
      new Request("http://localhost/api/webhooks/github/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      })
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Webhook verification failed" })
  })

  test("rejects WebSocket route access before subscription handling", async () => {
    const { sixb } = createRuntime({ auth: true })
    const port = await getFreePort()
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: `http://127.0.0.1:${port}` }),
    })

    await server.start()

    try {
      await expect(connectWebSocket(`ws://127.0.0.1:${port}/ws/events`)).rejects.toThrow()
    } finally {
      await server.stop()
    }
  })

  test("accepts WebSocket connections from allowed origins with the matching audience", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const port = await getFreePort()
    const apiOrigin = `http://127.0.0.1:${port}`
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin }),
    })

    await server.start()

    try {
      await expect(
        connectWebSocket(`ws://127.0.0.1:${port}/ws/events`, {
          origin: "http://app.localhost",
          cookie: seeded.cookie,
        })
      ).resolves.toBeUndefined()

      await expect(
        connectWebSocket(`ws://127.0.0.1:${port}/ws/events`, {
          origin: "http://app.localhost",
          cookie: `sixb_session=${seeded.credential.cookieValue}`,
        })
      ).rejects.toThrow()
    } finally {
      await server.stop()
    }
  })

  test("rejects WebSocket connections from unknown browser origins", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const port = await getFreePort()
    const apiOrigin = `http://127.0.0.1:${port}`
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin }),
    })

    await server.start()

    try {
      await expect(
        connectWebSocket(`ws://127.0.0.1:${port}/ws/events`, {
          origin: "http://evil.localhost",
          cookie: seeded.cookie,
        })
      ).rejects.toThrow()
    } finally {
      await server.stop()
    }
  })

  test("does not serve Atlas shell or assets from the API server", async () => {
    const { sixb } = createRuntime({ auth: true })
    const port = await getFreePort()
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: `http://127.0.0.1:${port}` }),
    })

    await server.start()

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const staticResponse = await fetch(`${baseUrl}/favicon.svg`)
      const fallbackIconResponse = await fetch(`${baseUrl}/favicon.ico`)
      const htmlResponse = await fetch(`${baseUrl}/dashboard/devices`, {
        redirect: "manual",
      })

      expect(staticResponse.status).toBe(404)
      expect(fallbackIconResponse.status).toBe(404)
      expect(htmlResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("redirects API-owned HTML routes with API-origin auth context", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy({ includeApp: false }),
      })
    )

    const response = await app.fetch(
      new Request("http://api.localhost/docs", {
        redirect: "manual",
      })
    )
    const location = new URL(response.headers.get("location") ?? "", "http://api.localhost")

    expect(response.status).toBe(302)
    expect(location.origin).toBe("http://api.localhost")
    expect(location.pathname).toBe("/auth/sign-in")
    expect(location.searchParams.get("audience")).toBe("atlas")
    expect(location.searchParams.get("returnTo")).toBe("http://api.localhost/docs")
  })

  test("allows API-owned docs mutations with the API-origin session and CSRF token", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({
        sixb,
        quiet: true,
        browser: createTestBrowserPolicy({ includeApp: false }),
      })
    )

    const response = await app.fetch(
      new Request("http://api.localhost/api/objects/device/fan-1", {
        method: "PUT",
        headers: {
          origin: "http://api.localhost",
          "content-type": "application/json",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          ...seeded.csrfHeader,
        },
        body: JSON.stringify({ properties: { name: "Fan" } }),
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://api.localhost")
  })
})

async function connectWebSocket(url: string, headers?: Record<string, string>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ws = createTestWebSocket(url, headers)
    let settled = false
    const settle = (callback: () => void) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      ws.close()
      settle(() => reject(new Error("WebSocket stayed open")))
    }, 1000)

    ws.addEventListener("open", () => {
      settle(() => {
        ws.close()
        resolvePromise()
      })
    })

    ws.addEventListener("error", () => {
      settle(() => {
        ws.close()
        reject(new Error("WebSocket connection failed"))
      })
    })

    ws.addEventListener("close", () => {
      settle(() => reject(new Error("WebSocket connection closed")))
    })
  })
}

function createTestWebSocket(url: string, headers?: Record<string, string>): WebSocket {
  if (!headers) {
    return new WebSocket(url)
  }

  const TestWebSocket = WebSocket as unknown as new (
    url: string,
    options: { readonly headers: Record<string, string> }
  ) => WebSocket

  return new TestWebSocket(url, { headers })
}
