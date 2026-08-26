import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"
import { magicLink, type SendMagicLinkInput } from "@sixb/auth-magic-link"
import {
  type AuthSessionOptions,
  defineGroup,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  SixbHost,
} from "@sixb/core"
import { createSixbApi, SixbServer, type SixbServerOptions } from "../src/server"
import { confirmCallback, createTestBrowserPolicy, linkFromLatestMessage } from "./helpers"

const projectId = "test-project"
const securityAdmins = defineGroup("security-admins")

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

function createSender() {
  const messages: SendMagicLinkInput[] = []
  return {
    messages,
    async sendMagicLink(message: SendMagicLinkInput): Promise<void> {
      messages.push(message)
    },
  }
}

function createRuntime(
  options: {
    readonly bootstrapUsers?: readonly string[]
    readonly bootstrapGroups?: readonly [typeof securityAdmins]
    readonly rateLimit?: false | { readonly perMinute?: number; readonly perHour?: number }
    readonly session?: AuthSessionOptions
    readonly authExperience?: SixbServerOptions["authExperience"]
  } = {}
) {
  const storage = new InMemoryStorage()
  const { messages, sendMagicLink } = createSender()
  const strategy = magicLink({
    allowedDomains: ["acme.com"],
    bootstrapUsers: options.bootstrapUsers ?? [],
    bootstrapGroups: options.bootstrapGroups ?? [],
    rateLimit: options.rateLimit,
    sendMagicLink,
  })
  const sixb = new SixbHost<readonly OntologySource[]>({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins],
    auth: options.session ? { strategy, session: options.session } : strategy,
  })

  return {
    app: createSixbApi(
      new SixbServer({
        host: sixb,
        quiet: true,
        browser: createTestBrowserPolicy(),
        ...(options.authExperience ? { authExperience: options.authExperience } : {}),
      })
    ),
    messages,
    sixb,
    storage,
  }
}

function customAuthBootstrap(html: string): {
  readonly state: { readonly kind: string; readonly email?: string }
  readonly signInUrl: string
  readonly submission?: {
    readonly kind: string
    readonly action: string
    readonly fields: Readonly<Record<string, string>>
  }
} {
  const encoded = html.match(/data-sixb-auth="([^"]+)"/)?.[1]
  if (!encoded) throw new Error("Expected a custom auth bootstrap")
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"))
}

async function createCustomAuthFixture(): Promise<{
  readonly outdir: string
  cleanup(): Promise<void>
}> {
  const outdir = await mkdtemp(join(tmpdir(), "sixb-custom-auth-"))
  await mkdir(join(outdir, "assets"), { recursive: true })
  await writeFile(
    join(outdir, "index.html"),
    '<!doctype html><html><body><div id="root" data-sixb-auth="__SIXB_AUTH_BOOTSTRAP__">Acme auth</div><script src="/auth/assets/auth-fixture.js"></script></body></html>'
  )
  const scriptPath = join(outdir, "assets", "auth-fixture.js")
  const script = "export {}\n"
  await writeFile(scriptPath, script)
  await writeFile(`${scriptPath}.br`, brotliCompressSync(script))
  await writeFile(`${scriptPath}.gz`, gzipSync(script))
  return {
    outdir,
    async cleanup() {
      await rm(outdir, { recursive: true, force: true })
    },
  }
}

async function postSignIn(
  app: ReturnType<typeof createSixbApi>,
  input: {
    readonly email: string
    readonly audience?: string
    readonly returnTo?: string
    readonly cookie?: string
  }
): Promise<Response> {
  const body = new URLSearchParams()
  body.set("audience", input.audience ?? "atlas")
  body.set("email", input.email)
  body.set("returnTo", input.returnTo ?? "http://atlas.localhost/")

  return app.fetch(
    new Request("http://api.localhost/auth/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(input.cookie ? { cookie: input.cookie } : {}),
      },
      body,
    })
  )
}

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`${name}=([^;,\\s]+)`))
  if (!match) {
    throw new Error(`Cookie ${name} was not set`)
  }
  return match[1]
}

async function signInAtlas(
  app: ReturnType<typeof createSixbApi>,
  messages: readonly { readonly text: string }[],
  email: string
): Promise<{
  readonly sessionCookie: string
  readonly csrfCookie: string
  readonly sessionId: string
}> {
  await postSignIn(app, { email })
  const link = linkFromLatestMessage(messages)
  const callback = await confirmCallback(app, link)
  const setCookie = callback.headers.get("set-cookie")
  const sessionCookie = cookieValue(setCookie, "sixb_session")
  const csrfCookie = cookieValue(setCookie, "sixb_csrf")
  const sessionResponse = await app.fetch(
    new Request("http://api.localhost/api/auth/session", {
      headers: { cookie: `sixb_session=${sessionCookie}` },
    })
  )
  const body = (await sessionResponse.json()) as { readonly session: { readonly id: string } }
  return { sessionCookie, csrfCookie, sessionId: body.session.id }
}

async function founderUserId(storage: InMemoryStorage): Promise<string> {
  const user = await storage.auth.users.getByEmail({ projectId, email: "founder@acme.com" })
  if (!user) {
    throw new Error("Expected founder user to exist")
  }
  return user.id
}

describe("magic-link auth routes", () => {
  test("renders a custom app auth experience while retaining the Atlas fallback", async () => {
    const fixture = await createCustomAuthFixture()
    try {
      const { app } = createRuntime({ authExperience: { outdir: fixture.outdir } })

      const custom = await app.fetch(
        new Request(
          "http://api.localhost/auth/sign-in?audience=app&returnTo=http%3A%2F%2Fapp.localhost%2Fnotes"
        )
      )
      const customHtml = await custom.text()
      const bootstrap = customAuthBootstrap(customHtml)

      expect(custom.status).toBe(200)
      expect(customHtml).toContain("Acme auth")
      expect(custom.headers.get("referrer-policy")).toBe("same-origin")
      expect(custom.headers.get("content-security-policy")).toContain(
        "form-action 'self'; frame-ancestors 'none'"
      )
      expect(bootstrap).toMatchObject({
        state: { kind: "signIn" },
        submission: {
          kind: "requestMagicLink",
          action: "/auth/sign-in",
          fields: { audience: "app", returnTo: "http://app.localhost/notes" },
        },
      })

      const atlas = await app.fetch(
        new Request(
          "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2F"
        )
      )
      expect(await atlas.text()).toContain('name="audience" value="atlas"')

      const asset = await app.fetch(new Request("http://api.localhost/auth/assets/auth-fixture.js"))
      expect(asset.status).toBe(200)
      expect(asset.headers.get("cache-control")).toContain("immutable")

      const head = await app.fetch(
        new Request("http://api.localhost/auth/assets/auth-fixture.js", { method: "HEAD" })
      )
      expect(head.status).toBe(200)
      expect(head.headers.get("content-type")).toBe(asset.headers.get("content-type"))
      expect(await head.text()).toBe("")

      const gzip = await app.fetch(
        new Request("http://api.localhost/auth/assets/auth-fixture.js", {
          headers: { "accept-encoding": "br;q=0, gzip;q=1" },
        })
      )
      expect(gzip.headers.get("content-encoding")).toBe("gzip")

      const identity = await app.fetch(
        new Request("http://api.localhost/auth/assets/auth-fixture.js", {
          headers: { "accept-encoding": "br;q=0, gzip;q=0" },
        })
      )
      expect(identity.headers.get("content-encoding")).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })

  test("custom app magic-link states preserve neutral delivery and scanner-safe confirmation", async () => {
    const fixture = await createCustomAuthFixture()
    try {
      const { app, messages } = createRuntime({
        authExperience: { outdir: fixture.outdir },
        bootstrapUsers: ["founder@acme.com"],
      })

      const requested = await postSignIn(app, {
        audience: "app",
        email: "founder@acme.com",
        returnTo: "http://app.localhost/notes",
      })
      expect(customAuthBootstrap(await requested.text()).state).toEqual({ kind: "checkEmail" })

      const link = linkFromLatestMessage(messages)
      expect(link.searchParams.get("audience")).toBe("app")
      expect(link.searchParams.get("returnTo")).toBeNull()

      const invalidLink = new URL(link)
      invalidLink.searchParams.set("token", "invalid")
      const invalid = await app.fetch(new Request(invalidLink, { redirect: "manual" }))
      const invalidBootstrap = customAuthBootstrap(await invalid.text())
      expect(invalid.status).toBe(400)
      expect(invalidBootstrap.state).toEqual({ kind: "invalidLink" })
      expect(invalidBootstrap.signInUrl).toBe(
        "/auth/sign-in?audience=app&returnTo=http%3A%2F%2Fapp.localhost%2F"
      )

      for (let i = 0; i < 2; i++) {
        const confirmation = await app.fetch(new Request(link.toString(), { redirect: "manual" }))
        const bootstrap = customAuthBootstrap(await confirmation.text())
        expect(confirmation.headers.get("content-security-policy")).toContain(
          "form-action 'self' http://app.localhost"
        )
        expect(bootstrap.state).toEqual({ kind: "confirm", email: "founder@acme.com" })
        expect(bootstrap.submission).toMatchObject({
          kind: "confirmSignIn",
          fields: {
            audience: "app",
            magicLinkId: link.searchParams.get("magicLinkId"),
            token: link.searchParams.get("token"),
          },
        })
        expect(bootstrap.signInUrl).toBe(
          "/auth/sign-in?audience=app&returnTo=http%3A%2F%2Fapp.localhost%2F"
        )
      }

      const completed = await confirmCallback(app, link)
      expect(completed.status).toBe(303)
      expect(completed.headers.get("location")).toBe("http://app.localhost/notes")
      expect(completed.headers.get("set-cookie")).toContain("sixb_session_app=")
    } finally {
      await fixture.cleanup()
    }
  })

  test("renders a safe custom error when callback validation is unavailable", async () => {
    const fixture = await createCustomAuthFixture()
    try {
      const { app, messages, storage } = createRuntime({
        authExperience: { outdir: fixture.outdir },
        bootstrapUsers: ["founder@acme.com"],
      })
      await postSignIn(app, {
        audience: "app",
        email: "founder@acme.com",
        returnTo: "http://app.localhost/notes",
      })

      storage.auth.magicLinks.getById = async () => {
        throw new Error("Storage unavailable")
      }
      const response = await app.fetch(
        new Request(linkFromLatestMessage(messages), { redirect: "manual" })
      )

      expect(response.status).toBe(500)
      expect(customAuthBootstrap(await response.text()).state).toEqual({ kind: "error" })
    } finally {
      await fixture.cleanup()
    }
  })

  test("renders the magic-link sign-in form for the magic-link strategy", async () => {
    const { app } = createRuntime()

    const response = await app.fetch(
      new Request(
        "http://api.localhost/auth/sign-in?audience=atlas&returnTo=http%3A%2F%2Fatlas.localhost%2Fobjects"
      )
    )
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('action="/auth/sign-in"')
    expect(html).toContain('name="email"')
    expect(html).toContain('name="audience" value="atlas"')
    expect(html).toContain('name="returnTo" value="http://atlas.localhost/objects"')
  })

  test("returns the same generic sign-in response for eligible and ineligible emails", async () => {
    const { app, messages, storage } = createRuntime()
    await storage.auth.users.create({
      id: "usr_1",
      projectId,
      email: "ava@acme.com",
    })

    const eligible = await postSignIn(app, { email: "ava@acme.com" })
    const ineligible = await postSignIn(app, { email: "unknown@acme.com" })

    expect(eligible.status).toBe(200)
    expect(ineligible.status).toBe(200)
    expect(await eligible.text()).toBe(await ineligible.text())
    expect(messages).toHaveLength(1)
  })

  test("callback creates a session, sets cookies, and exposes the session shape", async () => {
    const { app, messages, storage } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: [securityAdmins],
      session: {
        idleTimeoutMs: 60 * 60 * 1000,
        renewalWindowMs: 30 * 60 * 1000,
        absoluteTimeoutMs: 2 * 60 * 60 * 1000,
      },
    })

    await postSignIn(app, {
      email: "founder@acme.com",
      returnTo: "http://atlas.localhost/dashboard",
    })
    const link = linkFromLatestMessage(messages)
    const confirm = await app.fetch(new Request(link.toString(), { redirect: "manual" }))

    expect(confirm.status).toBe(200)
    expect(confirm.headers.get("set-cookie")).toBeNull()
    // `no-referrer` would make browsers POST the form with `Origin: null`,
    // which the browser-origin guard rejects.
    expect(confirm.headers.get("referrer-policy")).toBe("same-origin")
    const confirmHtml = await confirm.text()
    expect(confirmHtml).toContain("You're signing in as <strong>founder@acme.com</strong>.")
    expect(confirmHtml).toContain('<form method="post" action="/auth/callback" id="confirm">')
    expect(confirmHtml).toContain('<button type="submit" id="confirm-button">Continue</button>')

    const callback = await confirmCallback(app, link)

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://atlas.localhost/dashboard")
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "sixb_session")
    const csrfCookie = cookieValue(setCookie, "sixb_csrf")
    expect(sessionCookie).toContain(".")
    expect(csrfCookie).toBeTruthy()

    const sessionResponse = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          cookie: `sixb_session=${sessionCookie}`,
        },
      })
    )

    expect(sessionResponse.status).toBe(200)
    const sessionBody = await sessionResponse.json()
    expect(sessionBody).toMatchObject({
      authenticated: true,
      user: {
        email: "founder@acme.com",
        groupIds: ["security-admins"],
      },
      session: {
        id: expect.any(String),
      },
    })
    const user = await storage.auth.users.getByEmail({ projectId, email: "founder@acme.com" })
    if (!user) throw new Error("Expected callback user to be persisted")
    const [storedSession] = await storage.auth.sessions.listActiveByUserId({
      projectId,
      userId: user.id,
      now: new Date(),
    })
    if (!storedSession) throw new Error("Expected callback session to be persisted")
    expect(storedSession.absoluteExpiresAt?.getTime()).toBe(
      storedSession.createdAt.getTime() + 2 * 60 * 60 * 1000
    )
    const authCookies = (callback.headers as Headers & { getSetCookie(): string[] })
      .getSetCookie()
      .filter((cookie) => /^sixb_(session|csrf)=/.test(cookie))
    expect(authCookies).toHaveLength(2)
    for (const cookie of authCookies) {
      expect(cookie).toContain(`Expires=${storedSession.expiresAt.toUTCString()}`)
    }
  })

  test("GET with a wrong token is rejected without disclosing the email", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)
    link.searchParams.set("token", "not-the-real-token")

    const response = await app.fetch(new Request(link.toString(), { redirect: "manual" }))

    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("founder@acme.com")
  })

  test("a rate-limited resend keeps the pending cookie for the delivered link", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
      rateLimit: { perMinute: 1 },
    })

    const first = await postSignIn(app, { email: "founder@acme.com" })
    const pending = cookieValue(first.headers.get("set-cookie"), "sixb_pending")
    const link = linkFromLatestMessage(messages)

    // A second click within the rate limit sends no email and must not rotate
    // the secret backing the already-delivered link.
    const resend = await postSignIn(app, {
      email: "founder@acme.com",
      cookie: `sixb_pending=${pending}`,
    })

    expect(messages).toHaveLength(1)
    expect(cookieValue(resend.headers.get("set-cookie"), "sixb_pending")).toBe(pending)

    // The first (only) emailed link still fast-paths on this device.
    const callback = await app.fetch(
      new Request(link.toString(), {
        headers: { cookie: `sixb_pending=${pending}` },
        redirect: "manual",
      })
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.get("set-cookie")).toContain("sixb_session=")
  })

  test("emailed link survives repeated GET prefetches by email link scanners", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)

    // Safe Links / Avanan style scanners fetch the URL before the user does.
    for (let i = 0; i < 3; i++) {
      const prefetch = await app.fetch(new Request(link.toString(), { redirect: "manual" }))
      expect(prefetch.status).toBe(200)
      expect(prefetch.headers.get("set-cookie")).toBeNull()
    }

    const callback = await confirmCallback(app, link)

    expect(callback.status).toBe(303)
    expect(callback.headers.get("set-cookie")).toContain("sixb_session=")
  })

  test("callback refuses replayed confirmations without setting cookies", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)

    await confirmCallback(app, link)

    // Consumed links fail on GET before the confirmation click...
    const replayGet = await app.fetch(new Request(link.toString(), { redirect: "manual" }))
    expect(replayGet.status).toBe(400)

    // ...and a replayed POST with the original credentials is refused too.
    const body = new URLSearchParams()
    body.set("magicLinkId", link.searchParams.get("magicLinkId") ?? "")
    body.set("token", link.searchParams.get("token") ?? "")
    const replay = await app.fetch(
      new Request(new URL("/auth/callback", link).toString(), {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: link.origin,
        },
        body,
        redirect: "manual",
      })
    )

    expect(replay.status).toBe(400)
    expect(replay.headers.get("set-cookie")).toBeNull()
  })

  test("same-device fast path signs in straight from the emailed link", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    const signIn = await postSignIn(app, { email: "founder@acme.com" })
    const pendingCookie = cookieValue(signIn.headers.get("set-cookie"), "sixb_pending")
    const link = linkFromLatestMessage(messages)
    expect(link.searchParams.get("requester")).toBeTruthy()

    // Scanners never hold the pending cookie, so their GETs stay inert.
    const prefetch = await app.fetch(new Request(link.toString(), { redirect: "manual" }))
    expect(prefetch.status).toBe(200)
    expect(prefetch.headers.get("set-cookie")).toBeNull()

    const callback = await app.fetch(
      new Request(link.toString(), {
        headers: { cookie: `sixb_pending=${pendingCookie}` },
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://atlas.localhost/")
    const setCookie = callback.headers.get("set-cookie")
    expect(cookieValue(setCookie, "sixb_session")).toContain(".")
    expect(setCookie).toContain("sixb_pending=;")
  })

  // A direct 3xx after a cross-site navigation drops SameSite=Strict cookies on
  // the chained request, so API-origin return targets must finish on a document.
  test("API-origin return targets finish on a completion document", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, {
      email: "founder@acme.com",
      returnTo: "http://api.localhost/docs",
    })
    const link = linkFromLatestMessage(messages)
    const callback = await confirmCallback(app, link)

    expect(callback.status).toBe(200)
    expect(callback.headers.get("location")).toBeNull()
    expect(callback.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to 'self' http://api.localhost"
    )
    expect(await callback.clone().text()).toContain(
      '<meta http-equiv="refresh" content="0;url=http://api.localhost/docs">'
    )
    expect(cookieValue(callback.headers.get("set-cookie"), "sixb_session")).toContain(".")
  })

  test("a mismatched pending cookie falls back to the confirmation page", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)

    const callback = await app.fetch(
      new Request(link.toString(), {
        headers: { cookie: "sixb_pending=not-the-requester-preimage" },
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(200)
    expect(callback.headers.get("set-cookie")).toBeNull()
    expect(await callback.text()).toContain('action="/auth/callback"')

    // The link stays valid: the confirmation click still completes sign-in.
    const completed = await confirmCallback(app, link)
    expect(completed.status).toBe(303)
    expect(cookieValue(completed.headers.get("set-cookie"), "sixb_session")).toContain(".")
  })

  test("sign-in rejects unsafe returnTo values before sending a link", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    const response = await postSignIn(app, {
      email: "founder@acme.com",
      returnTo: "https://evil.com",
    })

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("This sign-in request is invalid.")
    expect(messages).toHaveLength(0)
  })

  test("API browser magic-link callbacks use the stored audience and return target", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })
    const body = new URLSearchParams()
    body.set("email", "founder@acme.com")
    body.set("audience", "app")
    body.set("returnTo", "http://app.localhost/dashboard")

    const signIn = await app.fetch(
      new Request("http://api.localhost/auth/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      })
    )
    const link = linkFromLatestMessage(messages)
    link.searchParams.set("returnTo", "http://evil.localhost/steal")
    const callback = await confirmCallback(app, link)

    expect(signIn.status).toBe(200)
    expect(link.origin).toBe("http://api.localhost")
    expect(callback.status).toBe(303)
    expect(callback.headers.get("location")).toBe("http://app.localhost/dashboard")

    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "sixb_session_app")
    const sessionResponse = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          origin: "http://app.localhost",
          cookie: `sixb_session_app=${sessionCookie}`,
        },
      })
    )

    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      user: { email: "founder@acme.com" },
      session: { id: expect.any(String) },
    })
  })

  test("API browser sign-in rejects return targets outside the audience origin", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })
    const body = new URLSearchParams()
    body.set("email", "founder@acme.com")
    body.set("audience", "app")
    body.set("returnTo", "http://evil.localhost/dashboard")

    const response = await app.fetch(
      new Request("http://api.localhost/auth/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      })
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("This sign-in request is invalid.")
    expect(messages).toHaveLength(0)
  })

  test("sign-out revokes the magic-link-created session and clears cookies", async () => {
    const { app, messages, storage } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)
    const callback = await confirmCallback(app, link)
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "sixb_session")
    const csrfCookie = cookieValue(setCookie, "sixb_csrf")
    const sessionResponse = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    const session = (await sessionResponse.json()) as {
      readonly authenticated: true
      readonly session: { readonly id: string }
    }

    const signOut = await app.fetch(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: `sixb_session=${sessionCookie}; sixb_csrf=${csrfCookie}`,
          "x-sixb-csrf": csrfCookie,
        },
      })
    )

    expect(signOut.status).toBe(200)
    expect(signOut.headers.get("set-cookie")).toContain("sixb_session=")
    await expect(
      storage.auth.sessions.getById({ projectId, id: session.session.id })
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    })
  })
})

describe("session management auth routes", () => {
  test("lists the caller's active sessions across audiences and flags the current one", async () => {
    const { app, messages, storage } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie, sessionId } = await signInAtlas(app, messages, "founder@acme.com")

    await storage.auth.sessions.create({
      id: "ses_app_extra",
      projectId,
      userId: await founderUserId(storage),
      strategyId: "magic-link",
      audience: "app",
      tokenHash: "hash-app-extra",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
      userAgent: "Mozilla/5.0 (iPhone)",
      ipAddress: "203.0.113.7",
    })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/sessions", {
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly sessions: ReadonlyArray<{
        readonly id: string
        readonly audience: string
        readonly current: boolean
        readonly userAgent?: string
        readonly ipAddress?: string
      }>
    }
    const current = body.sessions.find((entry) => entry.id === sessionId)
    const other = body.sessions.find((entry) => entry.id === "ses_app_extra")
    expect(current?.current).toBe(true)
    expect(other?.current).toBe(false)
    expect(other?.audience).toBe("app")
    expect(other?.userAgent).toBe("Mozilla/5.0 (iPhone)")
    expect(other?.ipAddress).toBe("203.0.113.7")
  })

  test("listing sessions requires authentication", async () => {
    const { app } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const response = await app.fetch(new Request("http://api.localhost/api/auth/sessions"))
    expect(response.status).toBe(401)
  })

  test("revokes one of the caller's other sessions and leaves the current one active", async () => {
    const { app, messages, storage } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie, csrfCookie, sessionId } = await signInAtlas(
      app,
      messages,
      "founder@acme.com"
    )

    await storage.auth.sessions.create({
      id: "ses_phone",
      projectId,
      userId: await founderUserId(storage),
      strategyId: "magic-link",
      audience: "atlas",
      tokenHash: "hash-phone",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/sessions/ses_phone/revoke", {
        method: "POST",
        headers: {
          cookie: `sixb_session=${sessionCookie}; sixb_csrf=${csrfCookie}`,
          "x-sixb-csrf": csrfCookie,
        },
      })
    )
    expect(response.status).toBe(200)
    // Revoking a non-current session does not clear the caller's cookies.
    expect(response.headers.get("set-cookie")).toBeNull()

    const revoked = await storage.auth.sessions.getById({ projectId, id: "ses_phone" })
    expect(revoked?.revokedAt).toBeInstanceOf(Date)

    const stillValid = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    expect(await stillValid.json()).toMatchObject({
      authenticated: true,
      session: { id: sessionId },
    })
  })

  test("cannot revoke a session that belongs to another user", async () => {
    const { app, messages, storage } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie, csrfCookie } = await signInAtlas(app, messages, "founder@acme.com")

    await storage.auth.users.create({ id: "usr_intruder", projectId, email: "mallory@acme.com" })
    await storage.auth.sessions.create({
      id: "ses_victim",
      projectId,
      userId: "usr_intruder",
      strategyId: "magic-link",
      audience: "atlas",
      tokenHash: "hash-victim",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/sessions/ses_victim/revoke", {
        method: "POST",
        headers: {
          cookie: `sixb_session=${sessionCookie}; sixb_csrf=${csrfCookie}`,
          "x-sixb-csrf": csrfCookie,
        },
      })
    )
    expect(response.status).toBe(404)

    const victim = await storage.auth.sessions.getById({ projectId, id: "ses_victim" })
    expect(victim?.revokedAt).toBeUndefined()
  })

  test("revoking a session requires a CSRF token", async () => {
    const { app, messages } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie, sessionId } = await signInAtlas(app, messages, "founder@acme.com")

    const response = await app.fetch(
      new Request(`http://api.localhost/api/auth/sessions/${sessionId}/revoke`, {
        method: "POST",
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    expect(response.status).toBe(403)
  })

  test("sign-out-all revokes every session across audiences and clears cookies", async () => {
    const { app, messages, storage } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie, csrfCookie, sessionId } = await signInAtlas(
      app,
      messages,
      "founder@acme.com"
    )

    await storage.auth.sessions.create({
      id: "ses_app_extra",
      projectId,
      userId: await founderUserId(storage),
      strategyId: "magic-link",
      audience: "app",
      tokenHash: "hash-app-extra",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    })

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/sign-out-all", {
        method: "POST",
        headers: {
          cookie: `sixb_session=${sessionCookie}; sixb_csrf=${csrfCookie}`,
          "x-sixb-csrf": csrfCookie,
        },
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, revokedCount: 2 })
    expect(response.headers.get("set-cookie")).toContain("sixb_session=")

    const current = await storage.auth.sessions.getById({ projectId, id: sessionId })
    const appExtra = await storage.auth.sessions.getById({ projectId, id: "ses_app_extra" })
    expect(current?.revokedAt).toBeInstanceOf(Date)
    expect(appExtra?.revokedAt).toBeInstanceOf(Date)

    const afterResponse = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    expect(await afterResponse.json()).toMatchObject({ authenticated: false })
  })

  test("sign-out-all requires a CSRF token", async () => {
    const { app, messages } = createRuntime({ bootstrapUsers: ["founder@acme.com"] })
    const { sessionCookie } = await signInAtlas(app, messages, "founder@acme.com")

    const response = await app.fetch(
      new Request("http://api.localhost/api/auth/sign-out-all", {
        method: "POST",
        headers: { cookie: `sixb_session=${sessionCookie}` },
      })
    )
    expect(response.status).toBe(403)
  })
})
