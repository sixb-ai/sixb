import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  type AuthCookieOptions,
  type AuthSessionOptions,
  can,
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
  prop,
  type RoleDefinition,
  SixbHost,
} from "@sixb/core"
import { createAccessTokenCredential, createSessionCredential } from "@sixb/core/internal/auth"
import { AuthStorageError } from "@sixb/core/storage"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "../src/auth/csrf"
import { DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES } from "../src/routes/files"
import { createSixbApi, MAX_WEBSOCKET_MESSAGE_BYTES, SixbServer } from "../src/server"
import { DEFAULT_REQUEST_BODY_LIMIT_BYTES } from "../src/utils/request-body"
import { createTestBrowserPolicy, getFreePort } from "./helpers"

const securityAdmins = defineGroup("security-admins")

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

// The origin tests below drive `PUT /api/objects/device/:id` because it is a mutation, not because
// they care about authorization. It enforces `edit:object` now, so they seed the grant to keep
// asserting the status the guard produces rather than the one the write grant would.
const deviceWriter = defineRole("device.writer", {
  grantedTo: [securityAdmins],
  grants: [can.view(Device), can.edit(Device)],
})

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

  const sixb = new SixbHost({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors: options.connector ? [connector] : [],
    groups: [securityAdmins],
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

function createApp(sixb: SixbHost) {
  return createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )
}

/** Serves `sixb` on a loopback port through the real Bun server, with its body and socket limits. */
async function withServer(
  sixb: SixbHost,
  run: (server: { readonly baseUrl: string; readonly port: number }) => Promise<void>
): Promise<void> {
  const port = await getFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = new SixbServer({
    host: sixb,
    hostname: "127.0.0.1",
    port,
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: baseUrl }),
  })
  await server.start()
  try {
    await run({ baseUrl, port })
  } finally {
    await server.stop()
  }
}

async function seedSession(
  storage: InMemoryStorage,
  params: {
    readonly status?: "active" | "suspended"
    readonly createdAt?: Date
    readonly expiresAt?: Date
    readonly absoluteExpiresAt?: Date
  } = {}
) {
  const credential = createSessionCredential("ses_1")
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
    tokenHash: credential.tokenHash,
    createdAt: params.createdAt ?? new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: params.expiresAt ?? new Date("2099-05-16T10:00:00.000Z"),
    absoluteExpiresAt: params.absoluteExpiresAt,
  })

  return {
    credential,
    cookie: `sixb_session_app=${credential.cookieValue}`,
    csrfCookie: `sixb_csrf_app=csrf_1`,
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
    subject: { type: "user", id: "usr_token" },
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return credential
}

describe("server auth guard", () => {
  test("tells a browser shell that the project runs without auth", async () => {
    const { sixb } = createRuntime()
    const app = createApp(sixb)

    const response = await app.fetch(new Request("http://localhost/api/auth/session"))

    // The app shell does not load the project, so this is how it learns not to redirect.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false, authEnabled: false })
  })

  test("fails closed in production when auth is missing", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"

    try {
      const { sixb } = createRuntime()
      expect(() => createApp(sixb)).toThrow("Auth is required in production")
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })

  // The guard owns this denial for every API route. The rows beyond the project are the
  // auth-management reads, which sit next to the public `/api/auth/session`.
  test("protects API routes with generic JSON 401", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createApp(sixb)

    for (const path of [
      "/api/project",
      "/api/auth/sessions",
      "/api/auth/members",
      "/api/auth/invitation-options",
    ]) {
      const response = await app.fetch(new Request(`http://localhost${path}`))

      expect(response.status, path).toBe(401)
      expect(await response.json()).toEqual({ error: "Authentication required" })
    }
  })

  // The guard owns both denials for every API mutation, before any route runs. The rows are the
  // object write and the auth-management mutations a forged cross-site request would aim at.
  test("requires authentication, then CSRF, for mutations", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)
    const mutations = [
      ["PUT", "/api/objects/device/fan-1", { properties: { name: "Fan" } }],
      ["POST", "/api/auth/invitations", { email: "ben@acme.com", groupIds: [] }],
      ["PATCH", "/api/auth/members/usr_2/groups", { groupIds: [] }],
      ["POST", "/api/auth/members/usr_2/suspend", undefined],
      ["POST", "/api/auth/sessions/ses_1/revoke", undefined],
      ["POST", "/api/auth/sign-out-all", undefined],
    ] as const

    const send = (
      [method, path, body]: (typeof mutations)[number],
      headers: Record<string, string> = {}
    ) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
          body: body ? JSON.stringify(body) : undefined,
        })
      )

    for (const mutation of mutations) {
      const label = `${mutation[0]} ${mutation[1]}`
      expect((await send(mutation)).status, `${label} anonymously`).toBe(401)
      const withoutCsrf = await send(mutation, { cookie: seeded.cookie })
      expect(withoutCsrf.status, `${label} without CSRF`).toBe(403)
      expect(await withoutCsrf.json(), `${label} without CSRF`).toEqual({
        error: "CSRF verification failed",
      })
    }

    // With the token, the invitation passes the guard and reaches the route, whose own 403 is for
    // the caller's missing membership policy.
    const withCsrf = await send(mutations[1], {
      cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
      ...seeded.csrfHeader,
    })
    expect(await withCsrf.json()).toEqual({
      error: expect.stringContaining("not allowed to create or manage invitations"),
    })
  })

  test("protects a route registered outside the known prefixes", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createApp(sixb).get("/internal/metrics", () => "secret")

    // This is the case the classifier's default actually governs. An *unregistered*
    // path 404s before the lifecycle hooks run, so it was never exposed; the trap was
    // the next route someone mounts outside /api, /ws and /docs, which the old
    // "public" default would have served to anyone. Adding it here reproduces that
    // exactly: the route matches, the guard runs, and it now demands a session.
    const response = await app.fetch(new Request("http://localhost/internal/metrics"))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Authentication required" })
  })

  test("accepts bearer tokens only on the access token route boundary", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const credential = await seedAccessToken(storage)
    const app = createApp(sixb)
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
    expect(await accepted.json()).toEqual({ id: "test-project", locale: "en", timeZone: "UTC" })
    expect(acceptedTelemetryRead.status).toBe(404)
    expect(acceptedActionRunDetail.status).toBe(404)
    expect(rejectedAuthManagement.status).toBe(403)
    // The token crosses the bearer-capable route boundary, then the authority-scoped ontology
    // deliberately makes an ObjectType without object.view indistinguishable from an unknown one.
    expect(rejectedRawWrite.status).toBe(404)
  })

  test("returns a safe session shape", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)

    const response = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: seeded.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      csrfToken: expect.any(String),
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
    expect(response.headers.get("set-cookie")).toContain("sixb_csrf_app=")
  })

  test("signs a device in as a bearer session that refreshes and signs out", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)

    const started = await app.fetch(
      new Request("http://localhost/api/auth/device-authorizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "sixb CLI on alex-mbp" }),
      })
    )
    expect(started.status).toBe(201)
    const authorization = (await started.json()) as {
      readonly deviceCode: string
      readonly userCode: string
      readonly verificationUriComplete: string
    }
    expect(authorization.verificationUriComplete).toContain("/auth/device?user_code=")

    const page = await app.fetch(
      new Request(authorization.verificationUriComplete, {
        headers: { cookie: `${seeded.cookie}; ${seeded.csrfCookie}` },
      })
    )
    expect(page.status).toBe(200)
    expect(await page.text()).toContain(authorization.userCode)

    const missingCsrf = await app.fetch(
      new Request("http://localhost/auth/device", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
        },
        body: new URLSearchParams({
          userCode: authorization.userCode,
          decision: "approve",
          csrfToken: "wrong",
        }),
      })
    )
    expect(missingCsrf.status).toBe(403)

    const approved = await app.fetch(
      new Request("http://localhost/auth/device", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
        },
        body: new URLSearchParams({
          userCode: authorization.userCode,
          decision: "approve",
          csrfToken: "csrf_1",
        }),
      })
    )
    expect(approved.status).toBe(200)

    const exchanged = await app.fetch(
      new Request("http://localhost/api/auth/device-authorizations/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: authorization.deviceCode }),
      })
    )
    expect(exchanged.status).toBe(200)
    const token = (await exchanged.json()) as {
      readonly status: string
      readonly accessToken: string
      readonly refreshToken: string
      readonly expiresIn: number
    }
    expect(token).toMatchObject({ status: "approved", expiresIn: 900 })
    expect(token.accessToken).toStartWith("sixb_at_")
    expect(token.refreshToken).toStartWith("sixb_rt_")

    const bearer = (accessToken: string, path: string, method = "GET") =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { authorization: `Bearer ${accessToken}` },
        })
      )
    // Unlike a personal access token, the session reaches every route, and needs no CSRF token.
    const sessions = await bearer(token.accessToken, "/api/auth/sessions")
    expect(sessions.status).toBe(200)
    const listed = (await sessions.json()) as {
      readonly sessions: ReadonlyArray<{ readonly id: string; readonly clientName?: string }>
    }
    const cliSession = listed.sessions.find((entry) => entry.clientName === "sixb CLI on alex-mbp")
    expect(cliSession).toMatchObject({ current: true })
    const whoami = await bearer(token.accessToken, "/api/auth/session")
    const identity = (await whoami.json()) as Record<string, unknown>
    expect(identity).toMatchObject({
      authenticated: true,
      user: { id: "usr_1", email: "ava@acme.com" },
      session: { id: cliSession?.id },
    })
    expect(identity.csrfToken).toBeUndefined()

    const created = await app.fetch(
      new Request("http://localhost/api/auth/access-tokens", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "ci", expiresAt: "2099-01-01T00:00:00.000Z" }),
      })
    )
    expect(created.status).toBe(201)

    const refreshed = await app.fetch(
      new Request("http://localhost/api/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: token.refreshToken }),
      })
    )
    expect(refreshed.status).toBe(200)
    const next = (await refreshed.json()) as { readonly accessToken: string }
    expect((await bearer(token.accessToken, "/api/project")).status).toBe(401)
    expect((await bearer(next.accessToken, "/api/project")).status).toBe(200)

    expect((await bearer(next.accessToken, "/api/auth/sign-out", "POST")).status).toBe(200)
    expect((await bearer(next.accessToken, "/api/project")).status).toBe(401)
    await expect(
      storage.auth.sessions.getById({ projectId: sixb.id, id: cliSession?.id ?? "" })
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) })

    const replayed = await app.fetch(
      new Request("http://localhost/api/auth/device-authorizations/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: authorization.deviceCode }),
      })
    )
    expect(await replayed.json()).toEqual({ status: "expired" })
  })

  test("signs in a browser that another browser approves, and only that browser", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
    )
    const start =
      "http://localhost/auth/sign-in/device?returnTo=http%3A%2F%2Fapp.localhost%2Forders&client=Acme+viewer"

    const started = await app.fetch(new Request(start))
    expect(started.status).toBe(303)
    const pendingUrl = new URL(started.headers.get("location") ?? "", start)
    const userCode = pendingUrl.searchParams.get("user_code") ?? ""
    expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    const deviceCookie = getSetCookies(started)
      .find((cookie) => cookie.startsWith("sixb_device="))
      ?.split(";")[0]
    expect(deviceCookie).toStartWith("sixb_device=dva_")
    const waiting = (cookie?: string) =>
      app.fetch(new Request(pendingUrl, { headers: cookie ? { cookie } : {} }))

    const pending = await waiting(deviceCookie)
    expect(pending.status).toBe(200)
    const pendingPage = await pending.text()
    expect(pendingPage).toContain(`/auth/device?user_code=${userCode}" target="_blank"`)
    expect(pendingPage).toContain('<meta http-equiv="refresh" content="2">')

    const approvalPage = await app.fetch(
      new Request(`http://localhost/auth/device?user_code=${userCode}`, {
        headers: { cookie: `${seeded.cookie}; ${seeded.csrfCookie}` },
      })
    )
    const approvalHtml = await approvalPage.text()
    expect(approvalHtml).toContain("Acme viewer")
    // Anyone can start a request under any name; the code is what the user checks.
    expect(approvalHtml).toContain("shows this same code")
    const approved = await app.fetch(
      new Request("http://localhost/auth/device", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
        },
        body: new URLSearchParams({ userCode, decision: "approve", csrfToken: "csrf_1" }),
      })
    )
    expect(approved.status).toBe(200)

    // The approved address alone is worth nothing: a browser without the cookie collects no session.
    const stranger = await waiting()
    expect(stranger.status).toBe(400)
    expect(getSetCookies(stranger).some((cookie) => cookie.startsWith("sixb_session"))).toBe(false)

    const completed = await waiting(deviceCookie)
    expect(completed.status).toBe(303)
    expect(completed.headers.get("location")).toBe("http://app.localhost/orders")
    const sessionCookie = getSetCookies(completed)
      .find((cookie) => cookie.startsWith("sixb_session_app="))
      ?.split(";")[0]
    expect(sessionCookie).toBeDefined()
    expect(getSetCookies(completed)).toContainEqual(
      expect.stringMatching(/^sixb_device=; .*Max-Age=0/)
    )

    const session = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: sessionCookie ?? "", origin: "http://app.localhost" },
      })
    )
    expect(await session.json()).toMatchObject({
      authenticated: true,
      user: { id: "usr_1" },
    })

    // Signed in, the same address is just a way back to the app.
    const again = await app.fetch(new Request(start, { headers: { cookie: sessionCookie ?? "" } }))
    expect(again.status).toBe(303)
    expect(again.headers.get("location")).toBe("http://app.localhost/orders")

    // The authorization was spent on that one session.
    const replayed = await waiting(deviceCookie)
    expect(replayed.status).toBe(400)
    expect(await replayed.text()).toContain("expired")
  })

  // Reproduce: catch only invalid_device_authorization in GET /auth/sign-in/device. The waiting
  // browser then gets a 500 and keeps its cookie, so every reload fails the same way.
  test("tells a waiting browser whose approved request is gone that it expired", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createSixbApi(
      new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
    )
    const start = "http://localhost/auth/sign-in/device?returnTo=http%3A%2F%2Fapp.localhost%2F"
    const started = await app.fetch(new Request(start))
    const pendingUrl = new URL(started.headers.get("location") ?? "", start)
    const deviceCookie =
      getSetCookies(started)
        .find((cookie) => cookie.startsWith("sixb_device="))
        ?.split(";")[0] ?? ""
    await app.fetch(
      new Request("http://localhost/auth/device", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
        },
        body: new URLSearchParams({
          userCode: pendingUrl.searchParams.get("user_code") ?? "",
          decision: "approve",
          csrfToken: "csrf_1",
        }),
      })
    )
    // Removed after the approval, before the waiting page's next reload.
    storage.auth.completeDeviceAuthorization = async () => {
      throw new AuthStorageError("missing_device_authorization", "[Sixb] Gone.")
    }

    const waited = await app.fetch(new Request(pendingUrl, { headers: { cookie: deviceCookie } }))

    expect(waited.status).toBe(400)
    expect(await waited.text()).toContain("expired")
    expect(getSetCookies(waited)).toContainEqual(
      expect.stringMatching(/^sixb_device=; .*Max-Age=0/)
    )
  })

  test("limits device authorizations per client address behind a trusted proxy", async () => {
    const { sixb } = createRuntime({ auth: true })
    await withServer(sixb, async ({ baseUrl }) => {
      // The test connects from loopback, a trusted proxy, so the appended entry is the client.
      const start = (forwardedFor: string) =>
        fetch(`${baseUrl}/api/auth/device-authorizations`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
          body: JSON.stringify({ clientName: "sixb CLI on alex-mbp" }),
        })

      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await start(`198.51.100.${attempt}, 203.0.113.7`)).status).toBe(201)
      }
      expect((await start("203.0.113.7")).status).toBe(429)
      expect((await start("203.0.113.8")).status).toBe(201)
    })
  })

  // Reproduce: drop the try/catch around approve/deny in POST /auth/device and this returns 500.
  test("renders the expired page when a device authorization was already decided", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)
    const started = await app.fetch(
      new Request("http://localhost/api/auth/device-authorizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientName: "sixb CLI on alex-mbp" }),
      })
    )
    const { userCode } = (await started.json()) as { readonly userCode: string }
    const decide = (decision: "approve" | "deny") =>
      app.fetch(
        new Request("http://localhost/auth/device", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          },
          body: new URLSearchParams({ userCode, decision, csrfToken: "csrf_1" }),
        })
      )

    expect((await decide("approve")).status).toBe(200)
    const late = await decide("deny")
    expect(late.status).toBe(400)
    expect(await late.text()).toContain("This authorization has expired")
  })

  // Atlas's cookie had the bare name. Reproduce: make the default session cookie `sixb_session` and
  // the old cookie signs in.
  test("resolves API browser sessions from the allowed origin and the app's cookie only", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)

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
    expect(await wrongCookieName.json()).toEqual({ authenticated: false, authEnabled: true })
  })

  test("rejects API browser requests from unknown origins", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createApp(sixb)

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
    const app = createApp(sixb)

    const allowed = await app.fetch(
      new Request("http://api.localhost/api/objects/device/fan-1", {
        method: "OPTIONS",
        headers: {
          origin: "http://app.localhost",
          "access-control-request-method": "PUT",
          "access-control-request-headers":
            "content-type,x-sixb-csrf,x-sixb-session-activity,x-sixb-share-grant",
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
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://app.localhost")
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true")
    expect(allowed.headers.get("access-control-allow-headers")).toBe(
      "authorization, content-type, x-sixb-csrf, x-sixb-session-activity, x-sixb-share-grant"
    )
    expect(rejected.status).toBe(403)
  })

  // The API's own origin is where its docs page sends mutations from.
  test("accepts CSRF-protected API mutations from the app origin and the API's own", async () => {
    const { sixb, storage } = createRuntime({ auth: true, roles: [deviceWriter] })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)

    for (const origin of ["http://app.localhost", "http://api.localhost"]) {
      const response = await app.fetch(
        new Request("http://api.localhost/api/objects/device/fan-1", {
          method: "PUT",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
            ...seeded.csrfHeader,
          },
          body: JSON.stringify({ properties: { name: "Fan" } }),
        })
      )

      expect(response.status, origin).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    }
  })

  test("sign-out revokes the session and clears cookies", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createApp(sixb)

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
    expect(response.headers.get("set-cookie")).toContain("sixb_session_app=")
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
    const app = createApp(sixb)

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

  // The upgrade is authenticated before subscription handling, from an allowed browser origin with
  // the app's cookie or with a native session's bearer token. An access token is not a session.
  test("authenticates WebSocket upgrades before subscription handling", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const nativeSession = await signInDevice(createApp(sixb), seeded)
    const personalToken = await seedAccessToken(storage)

    await withServer(sixb, async ({ port }) => {
      const connect = (headers?: Record<string, string>) =>
        connectWebSocket(`ws://127.0.0.1:${port}/ws/events`, headers).then(
          () => "open",
          () => "refused"
        )
      const appCookie = { origin: "http://app.localhost", cookie: seeded.cookie }

      expect(await connect()).toBe("refused")
      expect(await connect(appCookie)).toBe("open")
      expect(
        await connect({
          origin: "http://app.localhost",
          cookie: `sixb_session=${seeded.credential.cookieValue}`,
        })
      ).toBe("refused")
      expect(await connect({ ...appCookie, origin: "http://evil.localhost" })).toBe("refused")
      expect(await connect({ authorization: `Bearer ${nativeSession}` })).toBe("open")
      expect(await connect({ authorization: `Bearer ${personalToken.tokenValue}` })).toBe("refused")
    })
  })

  test("does not serve an app shell or assets from the API server", async () => {
    const { sixb } = createRuntime({ auth: true })
    await withServer(sixb, async ({ baseUrl }) => {
      const staticResponse = await fetch(`${baseUrl}/favicon.svg`)
      const fallbackIconResponse = await fetch(`${baseUrl}/favicon.ico`)
      const htmlResponse = await fetch(`${baseUrl}/dashboard/devices`, {
        redirect: "manual",
      })

      expect(staticResponse.status).toBe(404)
      expect(fallbackIconResponse.status).toBe(404)
      expect(htmlResponse.status).toBe(404)
    })
  })

  test("redirects API-owned HTML routes with API-origin auth context", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createApp(sixb)

    const response = await app.fetch(
      new Request("http://api.localhost/docs", {
        redirect: "manual",
      })
    )
    const location = new URL(response.headers.get("location") ?? "", "http://api.localhost")

    expect(response.status).toBe(302)
    expect(location.origin).toBe("http://api.localhost")
    expect(location.pathname).toBe("/auth/sign-in")
    expect(location.searchParams.get("returnTo")).toBe("http://api.localhost/docs")
  })

  // Reproduce: build the return target from the request's own origin in htmlAuthRedirectResponse.
  // Behind a proxy that ends TLS that origin is http://, and sign-in refuses it with a 400.
  test("returns a signed-out visitor to the API's public origin, not the proxied one", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createSixbApi(
      new SixbServer({
        host: sixb,
        quiet: true,
        browser: createTestBrowserPolicy({ apiOrigin: "https://api.example.com" }),
      })
    )

    // The proxy ended TLS, so the request reaches the API as plain HTTP.
    const response = await app.fetch(new Request("http://api.example.com/auth/device?user_code=X"))
    const location = new URL(response.headers.get("location") ?? "", "https://api.example.com")

    expect(response.status).toBe(302)
    expect(location.searchParams.get("returnTo")).toBe(
      "https://api.example.com/auth/device?user_code=X"
    )
    // Sign-in accepts it; this test's strategy has no page to show, rather than refusing it (400).
    expect((await app.fetch(new Request(location))).status).toBe(501)
  })
})

// A session that expires in five minutes sits inside the ten-minute renewal window of its 30-minute
// idle timeout. The clock is fixed so the renewed expiry is exact.
describe("session renewal", () => {
  const now = new Date("2026-07-01T10:00:00.000Z")

  beforeEach(() => setSystemTime(now))
  afterEach(() => setSystemTime())

  async function createExpiringSession(options: { readonly cookies?: AuthCookieOptions } = {}) {
    const { sixb, storage } = createRuntime({
      auth: true,
      cookies: options.cookies,
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
    return { app: createApp(sixb), seeded, storage }
  }

  test("renews session and CSRF cookies on foreground protected requests", async () => {
    const { app, seeded, storage } = await createExpiringSession()

    const response = await app.fetch(
      new Request("http://api.localhost/api/project", {
        headers: {
          origin: "http://app.localhost",
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          "x-sixb-session-activity": "1",
        },
      })
    )

    expect(response.status).toBe(200)
    const cookies = getSetCookies(response)
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain(`sixb_session_app=${seeded.credential.cookieValue}`)
    expect(cookies[1]).toContain("sixb_csrf_app=csrf_1")
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
  })

  test("repairs a missing CSRF cookie during session renewal", async () => {
    const { app, seeded } = await createExpiringSession()

    const response = await app.fetch(
      new Request("http://localhost/api/project", {
        headers: {
          cookie: seeded.cookie,
          "x-sixb-session-activity": "1",
        },
      })
    )

    expect(response.status).toBe(200)
    const csrfCookie = getSetCookies(response).find((cookie) => cookie.startsWith("sixb_csrf_app="))
    const csrfToken = csrfCookie?.match(/^sixb_csrf_app=([^;]+)/)?.[1]
    if (!csrfToken) throw new Error("Expected the renewed CSRF cookie to contain a token")
    expect(response.headers.get(CSRF_TOKEN_RESPONSE_HEADER_NAME)).toBe(csrfToken)
  })

  test("does not renew cookies without foreground activity", async () => {
    const { app, seeded } = await createExpiringSession()

    const response = await app.fetch(
      new Request("http://localhost/api/project", {
        headers: { cookie: `${seeded.cookie}; ${seeded.csrfCookie}` },
      })
    )

    expect(response.status).toBe(200)
    expect(getSetCookies(response)).toEqual([])
  })

  test("renews cookies from the public session endpoint without duplicating CSRF", async () => {
    const { app, seeded } = await createExpiringSession({ cookies: { csrfHttpOnly: true } })

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
      session: { expiresAt: "2026-07-01T10:30:00.000Z" },
    })
    const cookies = getSetCookies(response)
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain(`sixb_session_app=${seeded.credential.cookieValue}`)
    expect(cookies[1]).toContain(`sixb_csrf_app=${csrfToken}`)
    expect(cookies[1]).toContain("HttpOnly")
    expect(response.headers.get(CSRF_TOKEN_RESPONSE_HEADER_NAME)).toBe(csrfToken)
  })

  test("does not emit renewal cookies for a denied mutation", async () => {
    const { app, seeded, storage } = await createExpiringSession()

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
  })
})

// Elysia parses a request body before the auth guard runs, so these limits are what bound an
// anonymous caller. Each test names the change that shows its guard is load-bearing.
describe("request body limits", () => {
  // To check, drop `limitRequestBody` from `startApiServer`: the declared body reaches the guard
  // (401) and the chunked one is read until Bun's own limit.
  test("caps an anonymous JSON body before the auth guard runs", async () => {
    const { sixb } = createRuntime({ auth: true })
    await withServer(sixb, async ({ baseUrl }) => {
      const url = `${baseUrl}/api/objects/device/fan-1`
      const headers = { "content-type": "application/json" }
      const tooLarge = {
        error: `Request body exceeds the ${DEFAULT_REQUEST_BODY_LIMIT_BYTES} byte limit.`,
      }

      const declared = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          properties: { name: "x".repeat(DEFAULT_REQUEST_BODY_LIMIT_BYTES) },
        }),
      })
      expect(declared.status).toBe(413)
      expect(await declared.json()).toEqual(tooLarge)

      // This body never ends, so the server can only answer by stopping at the limit.
      const chunk = new Uint8Array(64 * 1024)
      const chunked = await fetch(url, {
        method: "PUT",
        headers,
        body: new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(chunk) }),
        duplex: "half",
      } as RequestInit & { duplex: "half" })
      expect(chunked.status).toBe(413)
      expect(await chunked.json()).toEqual(tooLarge)

      const normal = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ properties: { name: "Fan" } }),
      })
      expect(normal.status).toBe(401)
    })
  })

  // To check, remove the cap lift from `readRequestBodyWithLimit`: the upload fails with 413 and
  // the webhook answers with the server's message instead of its own.
  test("lets a route that reads its own body apply its own limit", async () => {
    const { sixb, storage } = createRuntime({ auth: true, connector: true })
    const credential = await seedAccessToken(storage)
    await withServer(sixb, async ({ baseUrl }) => {
      const form = new FormData()
      form.set("file", new File([new Uint8Array(2 * DEFAULT_REQUEST_BODY_LIMIT_BYTES)], "big.bin"))
      const upload = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential.tokenValue}` },
        body: form,
      })
      expect(upload.status).toBe(200)
      expect(await upload.json()).toMatchObject({ sizeBytes: 2 * DEFAULT_REQUEST_BODY_LIMIT_BYTES })

      const webhook = await fetch(`${baseUrl}/api/webhooks/github/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(DEFAULT_REQUEST_BODY_LIMIT_BYTES) }),
      })
      expect(webhook.status).toBe(413)
      expect(await webhook.json()).toEqual({
        error: `Webhook body exceeds ${DEFAULT_REQUEST_BODY_LIMIT_BYTES} bytes.`,
      })
    })
  })

  // To check, read the staged content in an Elysia `parse` hook instead of the handler: the
  // anonymous request gets a 413 instead of a 401.
  test("reads upload bodies only after authenticating the caller", async () => {
    const { sixb } = createRuntime({ auth: true })
    const app = createApp(sixb)
    const oversized = (method: string, path: string) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES + 1),
          },
          body: "small body",
        })
      )

    expect((await oversized("POST", "/api/files")).status).toBe(401)
    expect((await oversized("PUT", "/api/files/uploads/upl_1/content")).status).toBe(401)
  })

  // To check, drop `maxRequestBodySize` from `startApiServer`: the auth guard answers 401.
  test("rejects a body larger than any route reads before the app runs", async () => {
    const { sixb } = createRuntime({ auth: true })
    await withServer(sixb, async ({ port }) => {
      const statusLine = await readStatusLine(
        port,
        [
          "POST /api/files HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          `Content-Length: ${DEFAULT_SIMPLE_FILE_UPLOAD_BODY_BYTES + 1}`,
          "",
          "",
        ].join("\r\n")
      )
      expect(statusLine).toStartWith("HTTP/1.1 413")
    })
  })

  // To check, drop `maxPayloadLength` from `getElysiaWsHandler`: the server answers the message
  // with an error and keeps the socket open.
  test("closes a WebSocket that sends an oversized message", async () => {
    const { sixb, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    await withServer(sixb, async ({ port }) => {
      const ws = createTestWebSocket(`ws://127.0.0.1:${port}/ws/events`, {
        origin: "http://app.localhost",
        cookie: seeded.cookie,
      })
      const closed = new Promise<void>((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket stayed open"))
          ws.close()
        }, 1000)
        ws.addEventListener("close", () => {
          clearTimeout(timeout)
          resolvePromise()
        })
      })
      ws.addEventListener("open", () => ws.send("x".repeat(MAX_WEBSOCKET_MESSAGE_BYTES + 1)))

      await closed
    })
  })
})

/** Sends a raw request head and resolves with the response's status line. */
async function readStatusLine(port: number, head: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let received = ""
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(head)
        },
        data(socket, data) {
          received += data.toString()
          const end = received.indexOf("\r\n")
          if (end !== -1) {
            resolvePromise(received.slice(0, end))
            socket.end()
          }
        },
        close() {
          reject(new Error("Connection closed before a response"))
        },
        error(_socket, error) {
          reject(error)
        },
      },
    }).catch(reject)
  })
}

/** Sign a native client in through the device flow, approved by `seeded`'s browser session. */
async function signInDevice(
  app: ReturnType<typeof createSixbApi>,
  seeded: Awaited<ReturnType<typeof seedSession>>
): Promise<string> {
  const post = (path: string, init: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, { method: "POST", ...init }))
  const json = { "content-type": "application/json" }
  const started = await post("/api/auth/device-authorizations", {
    headers: json,
    body: JSON.stringify({ clientName: "sixb CLI" }),
  })
  const authorization = (await started.json()) as { deviceCode: string; userCode: string }
  const approved = await post("/auth/device", {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
    },
    body: new URLSearchParams({
      userCode: authorization.userCode,
      decision: "approve",
      csrfToken: "csrf_1",
    }),
  })
  expect(approved.status).toBe(200)
  const exchanged = await post("/api/auth/device-authorizations/token", {
    headers: json,
    body: JSON.stringify({ deviceCode: authorization.deviceCode }),
  })
  return ((await exchanged.json()) as { accessToken: string }).accessToken
}

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
