import { describe, expect, test } from "bun:test"
import { magicLink, type SendMagicLinkInput } from "@pario/auth-magic-link"
import {
  defineGroup,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Pario,
  prop,
} from "@pario/core"
import { createParioApi, ParioServer } from "../src/server"

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
    readonly browserApi?: boolean
  } = {}
) {
  const storage = new InMemoryStorage()
  const { messages, sendMagicLink } = createSender()
  const pario = new Pario<readonly OntologySource[]>({
    id: projectId,
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [securityAdmins],
    auth: magicLink({
      allowedDomains: ["acme.com"],
      bootstrapUsers: options.bootstrapUsers ?? [],
      bootstrapGroups: options.bootstrapGroups ?? [],
      sendMagicLink,
    }),
  })

  return {
    app: createParioApi(
      new ParioServer({
        pario,
        quiet: true,
        ...(options.browserApi
          ? {
              surface: {
                kind: "browserApi" as const,
                browser: {
                  publicOrigin: "http://api.localhost",
                  allowedOrigins: [
                    { origin: "http://admin.localhost", audience: "admin" as const },
                    { origin: "http://app.localhost", audience: "app" as const },
                  ],
                },
              },
            }
          : { ui: false }),
      })
    ),
    messages,
    pario,
    storage,
  }
}

function linkFromLatestMessage(messages: readonly { readonly text: string }[]): URL {
  const text = messages.at(-1)?.text ?? ""
  const match = text.match(/https?:\/\/\S+/)
  if (!match) {
    throw new Error("No magic link found in sent email")
  }
  return new URL(match[0])
}

async function postSignIn(
  app: ReturnType<typeof createParioApi>,
  input: { readonly email: string; readonly returnTo?: string }
): Promise<Response> {
  const body = new URLSearchParams()
  body.set("email", input.email)
  if (input.returnTo) {
    body.set("returnTo", input.returnTo)
  }

  return app.fetch(
    new Request("http://localhost/auth/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
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

describe("magic-link auth routes", () => {
  test("renders the magic-link sign-in form for the magic-link strategy", async () => {
    const { app } = createRuntime()

    const response = await app.fetch(new Request("http://localhost/auth/sign-in?returnTo=/objects"))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('action="/auth/sign-in"')
    expect(html).toContain('name="email"')
    expect(html).toContain('name="audience" value="admin"')
    expect(html).toContain('name="returnTo" value="/objects"')
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
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
      bootstrapGroups: [securityAdmins],
    })

    await postSignIn(app, { email: "founder@acme.com", returnTo: "/dashboard" })
    const link = linkFromLatestMessage(messages)
    const callback = await app.fetch(
      new Request(`http://localhost${link.pathname}${link.search}`, {
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(200)
    expect(callback.headers.get("location")).toBeNull()
    expect(callback.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to 'self'"
    )
    expect(await callback.clone().text()).toContain(
      '<meta http-equiv="refresh" content="0;url=/dashboard">'
    )
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "pario_session")
    const csrfCookie = cookieValue(setCookie, "pario_csrf")
    expect(sessionCookie).toContain(".")
    expect(csrfCookie).toBeTruthy()

    const sessionResponse = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: {
          cookie: `pario_session=${sessionCookie}`,
        },
      })
    )

    expect(sessionResponse.status).toBe(200)
    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      user: {
        email: "founder@acme.com",
        groupIds: ["security-admins"],
      },
      session: {
        id: expect.any(String),
      },
    })
  })

  test("callback refuses replayed links without setting cookies", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com" })
    const link = linkFromLatestMessage(messages)
    const callbackUrl = `http://localhost${link.pathname}${link.search}`

    await app.fetch(new Request(callbackUrl, { redirect: "manual" }))
    const replay = await app.fetch(new Request(callbackUrl, { redirect: "manual" }))

    expect(replay.status).toBe(400)
    expect(replay.headers.get("set-cookie")).toBeNull()
  })

  test("callback falls back to root for unsafe returnTo values", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
    })

    await postSignIn(app, { email: "founder@acme.com", returnTo: "https://evil.com" })
    const link = linkFromLatestMessage(messages)
    const callback = await app.fetch(
      new Request(`http://localhost${link.pathname}${link.search}`, {
        redirect: "manual",
      })
    )

    expect(callback.status).toBe(200)
    expect(callback.headers.get("location")).toBeNull()
    expect(await callback.text()).toContain('<meta http-equiv="refresh" content="0;url=/">')
  })

  test("browser API magic-link callbacks use the stored audience and return target", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
      browserApi: true,
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
    const callback = await app.fetch(new Request(link.toString(), { redirect: "manual" }))

    expect(signIn.status).toBe(200)
    expect(link.origin).toBe("http://api.localhost")
    expect(callback.status).toBe(200)
    expect(callback.headers.get("content-security-policy")).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; navigate-to 'self' http://app.localhost"
    )
    expect(await callback.clone().text()).toContain(
      '<meta http-equiv="refresh" content="0;url=http://app.localhost/dashboard">'
    )

    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "pario_session_app")
    const sessionResponse = await app.fetch(
      new Request("http://api.localhost/api/auth/session", {
        headers: {
          origin: "http://app.localhost",
          cookie: `pario_session_app=${sessionCookie}`,
        },
      })
    )

    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      user: { email: "founder@acme.com" },
      session: { id: expect.any(String) },
    })
  })

  test("browser API sign-in rejects return targets outside the audience origin", async () => {
    const { app, messages } = createRuntime({
      bootstrapUsers: ["founder@acme.com"],
      browserApi: true,
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
    const callback = await app.fetch(
      new Request(`http://localhost${link.pathname}${link.search}`, {
        redirect: "manual",
      })
    )
    const setCookie = callback.headers.get("set-cookie")
    const sessionCookie = cookieValue(setCookie, "pario_session")
    const csrfCookie = cookieValue(setCookie, "pario_csrf")
    const sessionResponse = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: `pario_session=${sessionCookie}` },
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
          cookie: `pario_session=${sessionCookie}; pario_csrf=${csrfCookie}`,
          "x-pario-csrf": csrfCookie,
        },
      })
    )

    expect(signOut.status).toBe(200)
    expect(signOut.headers.get("set-cookie")).toContain("pario_session=")
    await expect(
      storage.auth.sessions.getById({ projectId, id: session.session.id })
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    })
  })
})
