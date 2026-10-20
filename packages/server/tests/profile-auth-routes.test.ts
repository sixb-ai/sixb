import { describe, expect, test } from "bun:test"
import { magicLink } from "@sixb/auth-magic-link"
import { oidc } from "@sixb/auth-oidc"
import {
  type AuthStrategy,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createAccessTokenCredential, createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const projectId = "test-project"

function createRuntime(auth: AuthStrategy) {
  const storage = new InMemoryStorage()
  const sixb = new SixbHost({
    id: projectId,
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth,
  })

  return {
    app: createSixbApi(
      new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
    ),
    sixb,
    storage,
  }
}

function magicLinkRuntime() {
  return createRuntime(magicLink({ allowedDomains: ["acme.com"], async sendMagicLink() {} }))
}

// The provider is never contacted: these tests only read the identity sign-in stored.
function oidcRuntime() {
  return createRuntime(
    oidc({
      id: "okta",
      issuer: "https://idp.example",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
  )
}

// Ava, signed in through a browser session.
async function seedAva(storage: InMemoryStorage) {
  await storage.auth.users.create({
    id: "usr_ava",
    projectId,
    email: "ava@acme.com",
    displayName: "Ava",
  })

  const credential = createSessionCredential("ses_ava")
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: "usr_ava",
    strategyId: "magic-link",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-17T10:00:00.000Z"),
    expiresAt: new Date("2099-05-17T10:00:00.000Z"),
  })

  return { cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_ava` }
}

function getProfile(app: ReturnType<typeof createRuntime>["app"], cookie: string) {
  return app.fetch(new Request("http://localhost/api/auth/profile", { headers: { cookie } }))
}

function patchProfile(
  app: ReturnType<typeof createRuntime>["app"],
  headers: Record<string, string>,
  body: unknown
) {
  return app.fetch(
    new Request("http://localhost/api/auth/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-sixb-csrf": "csrf_ava", ...headers },
      body: JSON.stringify(body),
    })
  )
}

describe("profile auth routes", () => {
  // To see the session check fail, drop the cache invalidation from AuthRuntime.updateProfile.
  test("reads and changes your own name and picture", async () => {
    const { app, storage } = magicLinkRuntime()
    const { cookie } = await seedAva(storage)

    const initial = await getProfile(app, cookie)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({
      profile: { id: "usr_ava", email: "ava@acme.com", displayName: "Ava", status: "active" },
      managedFields: [],
    })

    // Read the session first, so the change has a cached copy to replace.
    await app.fetch(new Request("http://localhost/api/auth/session", { headers: { cookie } }))
    const updated = await patchProfile(
      app,
      { cookie },
      { displayName: "  Ava Lovelace ", avatarUrl: "https://images.acme.com/ava.png" }
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({
      profile: {
        id: "usr_ava",
        email: "ava@acme.com",
        displayName: "Ava Lovelace",
        avatarUrl: "https://images.acme.com/ava.png",
        status: "active",
      },
      managedFields: [],
    })

    const session = await app.fetch(
      new Request("http://localhost/api/auth/session", { headers: { cookie } })
    )
    expect(await session.json()).toMatchObject({ user: { displayName: "Ava Lovelace" } })

    const cleared = await patchProfile(app, { cookie }, { avatarUrl: null })
    expect(await cleared.json()).toEqual({
      profile: {
        id: "usr_ava",
        email: "ava@acme.com",
        displayName: "Ava Lovelace",
        status: "active",
      },
      managedFields: [],
    })
  })

  test("refuses invalid changes", async () => {
    const { app, storage } = magicLinkRuntime()
    const { cookie } = await seedAva(storage)

    for (const body of [
      {},
      { displayName: "a".repeat(101) },
      { displayName: "Ava\u0007" },
      { avatarUrl: "javascript:alert(1)" },
    ]) {
      const response = await patchProfile(app, { cookie }, body)
      expect({ body, status: response.status }).toEqual({ body, status: 400 })
    }

    // The body schema itself refuses a field you cannot change, as for every route.
    const email = await patchProfile(app, { cookie }, { email: "someone@acme.com" })
    expect(email.status).toBe(422)
  })

  // To see this fail, drop the managed-field check from AuthRuntime.updateProfile.
  test("refuses the fields the identity provider manages", async () => {
    const { app, storage } = oidcRuntime()
    const { cookie } = await seedAva(storage)
    await storage.auth.identities.upsert({
      projectId,
      strategyId: "okta",
      subject: "00u-ava",
      userId: "usr_ava",
      claims: { sub: "00u-ava", name: "Ava" },
    })

    const profile = await getProfile(app, cookie)
    expect(await profile.json()).toMatchObject({ managedFields: ["displayName"] })

    const renamed = await patchProfile(app, { cookie }, { displayName: "Ava" })
    expect(renamed.status).toBe(403)
    expect(await renamed.json()).toEqual({
      error: "[Sixb] Your identity provider manages displayName. Change it there.",
    })

    // Entra sends no picture claim, so the picture stays the person's own.
    const pictured = await patchProfile(
      app,
      { cookie },
      { avatarUrl: "https://images.acme.com/ava.png" }
    )
    expect(pictured.status).toBe(200)
  })

  // The auth guard owns the anonymous 401 and the missing-CSRF 403 for these routes.
  test("refuses an access token: only a session can change a profile", async () => {
    const { app, storage } = magicLinkRuntime()
    await seedAva(storage)
    const credential = createAccessTokenCredential("personal", "tok_ava")
    await storage.auth.accessTokens.create({
      id: credential.tokenId,
      projectId,
      name: "Scripts",
      kind: "personal",
      subject: { type: "user", id: "usr_ava" },
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-17T10:00:00.000Z"),
      expiresAt: new Date("2099-05-17T10:00:00.000Z"),
    })

    const withToken = await patchProfile(
      app,
      { authorization: `Bearer ${credential.tokenValue}` },
      { displayName: "Ava Lovelace" }
    )

    expect(withToken.status).toBe(403)
    await expect(storage.auth.users.getById({ projectId, id: "usr_ava" })).resolves.toMatchObject({
      displayName: "Ava",
    })
  })

  test("accepts a native client's session, such as the CLI's, without CSRF", async () => {
    const { app, sixb, storage } = magicLinkRuntime()
    await seedAva(storage)
    const { session, tokens } = sixb.auth.prepareBearerSession({
      userId: "usr_ava",
      clientName: "sixb CLI",
      now: new Date(),
    })
    await storage.auth.sessions.create(session)

    const response = await patchProfile(
      app,
      { authorization: `Bearer ${tokens.accessToken}`, "x-sixb-csrf": "" },
      { displayName: "Ava Lovelace" }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ profile: { displayName: "Ava Lovelace" } })
  })
})
