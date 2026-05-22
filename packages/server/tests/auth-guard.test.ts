import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  createSessionCredential,
  defineConnector,
  defineObjectType,
  defineWebhook,
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

function createRuntime(options: { readonly auth?: boolean; readonly connector?: boolean } = {}) {
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

  const pario = new Pario<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    connectors: options.connector ? [connector] : [],
    auth: options.auth ? authStrategy : undefined,
  })

  return { pario, storage }
}

async function seedSession(
  storage: InMemoryStorage,
  params: { readonly audience?: "admin" | "app"; readonly status?: "active" | "suspended" } = {}
) {
  const credential = createSessionCredential("ses_1")
  const audience = params.audience ?? "admin"
  const cookieSuffix = audience === "admin" ? "" : `_${audience}`
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
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return {
    credential,
    cookie: `pario_session${cookieSuffix}=${credential.cookieValue}`,
    csrfCookie: `pario_csrf${cookieSuffix}=csrf_1`,
    csrfHeader: { "x-pario-csrf": "csrf_1" },
  }
}

describe("server auth guard", () => {
  test("leaves routes open when auth is not configured outside production", async () => {
    const { pario } = createRuntime()
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))

    const response = await app.fetch(new Request("http://localhost/api/project"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: "test-project", type: "local" })
  })

  test("fails closed in production when auth is missing", () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"

    try {
      const { pario } = createRuntime()
      expect(() => createParioApi(new ParioServer({ pario, quiet: true, ui: false }))).toThrow(
        "Auth is required in production"
      )
    } finally {
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })

  test("protects API routes with generic JSON 401", async () => {
    const { pario } = createRuntime({ auth: true })
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))

    const response = await app.fetch(new Request("http://localhost/api/project"))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Authentication required" })
  })

  test("returns a safe session shape", async () => {
    const { pario, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))

    const response = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: seeded.cookie },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
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
  })

  test("resolves sessions with the server audience cookie names", async () => {
    const { pario, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage, { audience: "app" })
    const app = createParioApi(
      new ParioServer({ pario, quiet: true, ui: false, sessionAudience: "app" })
    )

    const accepted = await app.fetch(
      new Request("http://localhost/api/auth/session", {
        headers: { cookie: seeded.cookie },
      })
    )
    const adminCookie = await app.fetch(
      new Request("http://localhost/api/project", {
        headers: { cookie: `pario_session=${seeded.credential.cookieValue}` },
      })
    )

    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      authenticated: true,
      session: { id: "ses_1" },
    })
    expect(adminCookie.status).toBe(401)
  })

  test("requires CSRF only after authentication for mutations", async () => {
    const { pario, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))
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

  test("sign-out revokes the session and clears cookies", async () => {
    const { pario, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))

    const response = await app.fetch(
      new Request("http://localhost/api/auth/sign-out", {
        method: "POST",
        headers: {
          cookie: `${seeded.cookie}; ${seeded.csrfCookie}`,
          ...seeded.csrfHeader,
        },
      })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(response.headers.get("set-cookie")).toContain("pario_session=")
    await expect(
      storage.auth.sessions.getById({ projectId: "test-project", id: "ses_1" })
    ).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    })
  })

  test("keeps webhooks public while connector verification remains authoritative", async () => {
    const { pario } = createRuntime({ auth: true, connector: true })
    const app = createParioApi(new ParioServer({ pario, quiet: true, ui: false }))

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
    const { pario } = createRuntime({ auth: true })
    const port = await getFreePort()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
    })

    await server.start()

    try {
      await expect(connectWebSocket(`ws://127.0.0.1:${port}/ws/events`)).rejects.toThrow()
    } finally {
      await server.stop()
    }
  })

  test("redirects protected built-in UI routes while keeping static assets public", async () => {
    const { pario } = createRuntime({ auth: true })
    const port = await getFreePort()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
    })

    await server.start()

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const staticResponse = await fetch(`${baseUrl}/favicon.svg`)
      const fallbackIconResponse = await fetch(`${baseUrl}/favicon.ico`)
      const htmlResponse = await fetch(`${baseUrl}/dashboard/devices`, {
        redirect: "manual",
      })

      expect(staticResponse.status).toBe(200)
      expect(fallbackIconResponse.status).toBe(204)
      expect(htmlResponse.status).toBe(302)
      expect(htmlResponse.headers.get("location")).toBe(
        "/auth/sign-in?returnTo=%2Fdashboard%2Fdevices"
      )
    } finally {
      await server.stop()
    }
  })

  test("serves protected built-in UI routes in development for authenticated sessions", async () => {
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "development"
    const { pario, storage } = createRuntime({ auth: true })
    const seeded = await seedSession(storage)
    const port = await getFreePort()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
    })

    try {
      await server.start()

      const response = await fetch(`http://127.0.0.1:${port}/dashboard/devices`, {
        headers: { cookie: seeded.cookie },
      })

      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('<div id="root"></div>')
      expect(html).toContain('"auth":{"csrfCookieName":"pario_csrf"}')
    } finally {
      await server.stop()
      if (previous === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previous
      }
    }
  })

  test("protects custom app HTML with the app audience while keeping assets public", async () => {
    const { pario, storage } = createRuntime({ auth: true })
    const adminSession = await seedSession(storage)
    const appCredential = createSessionCredential("ses_app")
    await storage.auth.sessions.create({
      id: appCredential.sessionId,
      projectId: "test-project",
      userId: "usr_1",
      strategyId: "test",
      audience: "app",
      tokenHash: appCredential.tokenHash,
      createdAt: new Date("2026-05-16T10:01:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })
    const port = await getFreePort()
    let stopCount = 0
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
      surface: {
        kind: "customApp",
        app: {
          kind: "production",
          async indexHtml() {
            return "<!doctype html><html><head></head><body>App</body></html>"
          },
          async asset(pathname) {
            if (pathname === "/main.js") {
              return {
                body: "console.log('app')",
                contentType: "text/javascript; charset=utf-8",
              }
            }

            return null
          },
          async html() {
            return null
          },
          async stop() {
            stopCount++
          },
        },
      },
    })

    await server.start()

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const asset = await fetch(`${baseUrl}/main.js`)
      const unauthenticatedHtml = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" })
      const adminCookieHtml = await fetch(`${baseUrl}/dashboard`, {
        headers: { cookie: adminSession.cookie },
        redirect: "manual",
      })
      const appHtml = await fetch(`${baseUrl}/dashboard`, {
        headers: { cookie: `pario_session_app=${appCredential.cookieValue}` },
      })
      const wrongSessionAudience = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { cookie: adminSession.cookie },
      })
      const appSession = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { cookie: `pario_session_app=${appCredential.cookieValue}` },
      })
      const missingHtml = await fetch(`${baseUrl}/missing.html`, {
        headers: { cookie: `pario_session_app=${appCredential.cookieValue}` },
      })
      const mutation = await fetch(`${baseUrl}/dashboard`, { method: "POST" })

      expect(asset.status).toBe(200)
      expect(await asset.text()).toContain("console.log")
      expect(unauthenticatedHtml.status).toBe(302)
      expect(adminCookieHtml.status).toBe(302)
      expect(mutation.status).toBe(405)
      expect(await wrongSessionAudience.json()).toEqual({ authenticated: false })
      expect(await appSession.json()).toMatchObject({
        authenticated: true,
        session: { id: "ses_app" },
      })
      expect(missingHtml.status).toBe(404)

      expect(appHtml.status).toBe(200)
      const html = await appHtml.text()
      expect(html).toContain("window.__PARIO_RUNTIME__")
      expect(html).toContain('"auth":{"csrfCookieName":"pario_csrf_app"}')
    } finally {
      await server.stop()
      await server.stop()
    }

    expect(stopCount).toBe(1)
  })
})

async function connectWebSocket(url: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("WebSocket stayed open"))
    }, 1000)

    ws.addEventListener("open", () => {
      clearTimeout(timeout)
      ws.close()
      resolvePromise()
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      ws.close()
      reject(new Error("WebSocket connection failed"))
    })

    ws.addEventListener("close", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket connection closed"))
    })
  })
}
