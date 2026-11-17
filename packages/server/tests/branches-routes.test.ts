import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  type AuthorizationContext,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type SandboxFactory,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { getProjectBranches } from "@sixb/core/internal/branches"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestSixb } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { isPublicRoute } from "../src/auth/public-routes"
import { registerBranchRoutes } from "../src/routes/branches"
import { registerSourceWebhookRoutes } from "../src/routes/source-webhook"

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
const sandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  configuration: {},
  create: forbidden,
  resume: forbidden,
}

/** Stands in for a branch's runtime: echoes what reached it, and its WebSocket echoes too. */
function startRuntime() {
  return Bun.serve<{ readonly key: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { key: request.headers.get("x-sixb-branch-key") } })) {
        return undefined
      }
      const url = new URL(request.url)
      return Response.json(
        {
          path: `${url.pathname}${url.search}`,
          method: request.method,
          body: request.body ? "present" : null,
          key: request.headers.get("x-sixb-branch-key"),
          cookie: request.headers.get("cookie"),
          authorization: request.headers.get("authorization"),
        },
        { headers: { "set-cookie": "branch=1", "x-branch": "yes" } }
      )
    },
    websocket: {
      message(ws, message) {
        ws.send(`echo:${message}:${ws.data.key}`)
      },
    },
  })
}

describe("a project's branches over HTTP", () => {
  const stops: (() => unknown)[] = []
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
  })

  async function setup(
    grants: Partial<AuthorizationContext["grants"]> = { "manage:source": true }
  ) {
    const storage = new InMemoryStorage()
    const sixb = new SixbHost({
      id: "branches-test",
      ontology: [],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes,
      source: { repository: "acme/operations" },
    })
    const authorization: AuthorizationContext = {
      principal: { type: "user", id: "u1" },
      groupIds: [],
      roleIds: [],
      grants: { ...emptyGrantIndex(), ...grants },
    }
    const app = new Elysia()
    app.derive(({ request }) => ({
      sixb: bindRequestExecution(sixb, {
        request,
        authorization: { type: "principal", context: authorization },
      }),
    }))
    registerBranchRoutes(app, sixb)
    app.listen({ hostname: "127.0.0.1", port: 0 })
    stops.push(() => app.stop(true))
    const origin = `http://127.0.0.1:${app.server?.port}`
    return { storage, origin }
  }

  test("open, list, get and stop take can.manage(project.source)", async () => {
    const outsider = await setup({})
    expect((await fetch(`${outsider.origin}/api/branches`)).status).toBe(403)

    const { origin } = await setup()
    const opened = await fetch(`${origin}/api/branches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "feature/invoices" }),
    })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toMatchObject({
      name: "feature/invoices",
      wanted: "running",
      state: "stopped",
    })

    const listed = (await (await fetch(`${origin}/api/branches`)).json()) as {
      branches: Record<string, unknown>[]
    }
    expect(listed.branches.map((branch) => branch.name)).toEqual(["feature/invoices"])
    expect(Object.keys(listed.branches[0] ?? {})).not.toContain("key")

    const got = await fetch(`${origin}/api/branches/${encodeURIComponent("feature/invoices")}`)
    expect((await got.json()).name).toBe("feature/invoices")
    const stopped = await fetch(`${origin}/api/branches/feature%2Finvoices/stop`, {
      method: "POST",
    })
    expect((await stopped.json()).wanted).toBe("stopped")

    expect((await fetch(`${origin}/api/branches/missing`)).status).toBe(404)
    const invalid = await fetch(`${origin}/api/branches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a;b" }),
    })
    expect(invalid.status).toBe(400)
  })

  test("forwards a ready branch's requests with its key, and none of the caller's credentials", async () => {
    const runtime = startRuntime()
    stops.push(() => runtime.stop(true))
    const { storage, origin } = await setup()
    await fetch(`${origin}/api/branches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fix" }),
    })
    const forward = (path: string, init?: RequestInit) =>
      fetch(`${origin}/branches/fix${path}`, init)

    expect((await forward("/api/objects")).status).toBe(503)
    const branch = await storage.branches.get({ projectId: "branches-test", name: "fix" })
    await storage.branches.update(
      { projectId: "branches-test", name: "fix", at: new Date() },
      { state: "ready", url: `http://127.0.0.1:${runtime.port}` }
    )

    const response = await forward("/api/objects?limit=1", {
      method: "POST",
      headers: {
        cookie: "sixb_session=secret",
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ a: 1 }),
    })
    // Drop the request-header filter and the session and token reach the branch.
    expect(await response.json()).toEqual({
      path: "/api/objects?limit=1",
      method: "POST",
      body: "present",
      key: branch?.key,
      cookie: null,
      authorization: null,
    })
    expect(response.headers.get("x-branch")).toBe("yes")
    expect(response.headers.get("set-cookie")).toBeNull()

    const socket = new WebSocket(`${origin.replace("http", "ws")}/branches/fix/ws/events`)
    const reply = await new Promise<string>((resolve, reject) => {
      socket.onopen = () => socket.send("hello")
      socket.onmessage = (event) => resolve(String(event.data))
      socket.onerror = () => reject(new Error("The forwarded socket failed."))
    })
    socket.close()
    expect(reply).toBe(`echo:hello:${branch?.key}`)
  })
})

describe("the repository's push webhook", () => {
  const secret = "webhook-secret"
  const sign = (body: string, key = secret) =>
    `sha256=${createHmac("sha256", key).update(body).digest("hex")}`

  async function setup() {
    const storage = new InMemoryStorage()
    const sixb = new SixbHost({
      id: "source-webhook-test",
      ontology: [],
      broker: new InMemoryBroker(),
      storage,
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
      sandboxes,
      source: { repository: "acme/operations", webhookSecret: secret },
    })
    const app = registerSourceWebhookRoutes(new Elysia(), sixb)
    const deliver = (payload: unknown, options: { key?: string; event?: string } = {}) => {
      const body = JSON.stringify(payload)
      return app.handle(
        new Request("http://localhost/api/source/github", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-github-event": options.event ?? "push",
            "x-hub-signature-256": sign(body, options.key),
          },
          body,
        })
      )
    }
    const pushedAt = async () =>
      (await storage.branches.get({ projectId: sixb.id, name: "fix" }))?.pushedAt ?? null
    return { storage, sixb, deliver, pushedAt }
  }

  test("a signed push to a branch with a runtime tells it to pull", async () => {
    expect(isPublicRoute("/api/source/github", "POST")).toBe(true)
    const { sixb, deliver, pushedAt } = await setup()
    await getProjectBranches(
      createTestSixb(sixb, {
        authorization: {
          principal: { type: "user", id: "u1" },
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "manage:source": true },
        },
      })
    ).open("fix")
    const push = { ref: "refs/heads/fix", repository: { full_name: "Acme/Operations" } }

    expect((await deliver(push, { key: "wrong" })).status).toBe(401)
    expect(await pushedAt()).toBeNull()

    expect((await deliver({ ...push, repository: { full_name: "acme/other" } })).status).toBe(200)
    expect((await deliver({ ...push, ref: "refs/tags/v1" })).status).toBe(200)
    expect((await deliver(push, { event: "ping" })).status).toBe(200)
    expect(await pushedAt()).toBeNull()

    expect((await deliver(push)).status).toBe(200)
    expect(await pushedAt()).toBeInstanceOf(Date)
  })
})
