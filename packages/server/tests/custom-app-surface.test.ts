import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  createSessionCredential,
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
import { ParioServer } from "../src/server"

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const authStrategy = {
  id: "test",
  kind: "dev" as const,
}

const openServers: ParioServer[] = []
const openBunServers: ReturnType<typeof Bun.serve>[] = []

afterEach(async () => {
  for (const server of openServers.splice(0).reverse()) {
    await server.stop()
  }

  for (const server of openBunServers.splice(0).reverse()) {
    server.stop(true)
  }
})

describe("custom app same-origin surface", () => {
  test("protects development navigation while keeping constrained public proxy paths public", async () => {
    const upstreamPort = await getFreePort()
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: upstreamPort,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/assets/main.js") {
          return new Response("console.log('dev asset')", {
            headers: { "content-type": "text/javascript; charset=utf-8" },
          })
        }

        return new Response("<!doctype html><html><head></head><body>Dev App</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      },
    })
    openBunServers.push(upstream)

    const { pario, storage } = createRuntime({ auth: true })
    const session = await seedSession(storage, "app")
    const port = await getFreePort()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
      surface: {
        kind: "customApp",
        app: {
          kind: "development",
          origin: new URL(`http://127.0.0.1:${upstreamPort}`),
          hmrWebSocketPaths: [{ kind: "exact", path: "/_bun/hmr" }],
          publicProxyPaths: [{ kind: "prefix", path: "/assets/" }],
          publicAssetPaths: new Set(),
          async stop() {},
        },
      },
    })
    openServers.push(server)
    await server.start()

    const baseUrl = `http://127.0.0.1:${port}`
    const publicAsset = await fetch(`${baseUrl}/assets/main.js`)
    const publicHtmlFallback = await fetch(`${baseUrl}/assets/missing.js`)
    const unauthenticatedHtml = await fetch(`${baseUrl}/dashboard`, { redirect: "manual" })
    const authenticatedHtml = await fetch(`${baseUrl}/dashboard`, {
      headers: { cookie: session.cookie },
    })

    expect(publicAsset.status).toBe(200)
    expect(await publicAsset.text()).toContain("dev asset")
    expect(publicHtmlFallback.status).toBe(404)
    expect(unauthenticatedHtml.status).toBe(302)
    expect(authenticatedHtml.status).toBe(200)
    expect(await authenticatedHtml.text()).toContain('"csrfCookieName":"pario_csrf_app"')
  })

  test("bridges custom app HMR WebSockets without stealing reserved Pario WebSockets", async () => {
    const upstreamPort = await getFreePort()
    let upstreamClosed = false
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: upstreamPort,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/_bun/hmr" && server.upgrade(request)) {
          return undefined
        }

        return new Response("Not Found", { status: 404 })
      },
      websocket: {
        open(ws) {
          ws.send("hello")
        },
        message(ws, message) {
          if (message === "ping") {
            ws.send("pong")
          }
        },
        close() {
          upstreamClosed = true
        },
      },
    })
    openBunServers.push(upstream)

    const { pario } = createRuntime()
    const port = await getFreePort()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port,
      quiet: true,
      surface: {
        kind: "customApp",
        app: {
          kind: "development",
          origin: new URL(`http://127.0.0.1:${upstreamPort}`),
          hmrWebSocketPaths: [{ kind: "exact", path: "/_bun/hmr" }],
          publicProxyPaths: [],
          publicAssetPaths: new Set(),
          async stop() {},
        },
      },
    })
    openServers.push(server)
    await server.start()

    const messages = await roundTripWebSocket(`ws://127.0.0.1:${port}/_bun/hmr`)
    const reservedMessage = await firstWebSocketMessage(`ws://127.0.0.1:${port}/ws/events`)

    expect(messages).toEqual(["hello", "pong"])
    expect(upstreamClosed).toBe(true)
    expect(JSON.parse(reservedMessage)).toMatchObject({ type: "connected", channel: "events" })
  })

  test("rejects custom app public paths that shadow reserved routes", async () => {
    const { pario } = createRuntime()
    const server = new ParioServer({
      pario,
      host: "127.0.0.1",
      port: await getFreePort(),
      quiet: true,
      surface: {
        kind: "customApp",
        app: {
          kind: "development",
          origin: new URL("http://127.0.0.1:65535"),
          hmrWebSocketPaths: [],
          publicProxyPaths: [{ kind: "prefix", path: "/api/" }],
          publicAssetPaths: new Set(),
          async stop() {},
        },
      },
    })

    await expect(server.start()).rejects.toThrow("cannot shadow reserved path /api/")
  })
})

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const pario = new Pario<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Device],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: options.auth ? authStrategy : undefined,
  })

  return { pario, storage }
}

async function seedSession(storage: InMemoryStorage, audience: "admin" | "app") {
  const credential = createSessionCredential("ses_1")
  await storage.auth.users.create({
    id: "usr_1",
    projectId: "test-project",
    email: "ava@acme.com",
    status: "active",
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

  const suffix = audience === "admin" ? "" : `_${audience}`
  return {
    cookie: `pario_session${suffix}=${credential.cookieValue}`,
  }
}

async function roundTripWebSocket(url: string): Promise<string[]> {
  return await new Promise<string[]>((resolvePromise, reject) => {
    const messages: string[] = []
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("WebSocket round trip timed out"))
    }, 2000)

    ws.addEventListener("message", (event) => {
      messages.push(String(event.data))
      if (event.data === "hello") {
        ws.send("ping")
      }
      if (event.data === "pong") {
        clearTimeout(timeout)
        ws.close()
        setTimeout(() => resolvePromise(messages), 20)
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket connection failed"))
    })
  })
}

async function firstWebSocketMessage(url: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error("WebSocket message timed out"))
    }, 2000)

    ws.addEventListener("message", (event) => {
      clearTimeout(timeout)
      ws.close()
      resolvePromise(String(event.data))
    })

    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      reject(new Error("WebSocket connection failed"))
    })
  })
}
