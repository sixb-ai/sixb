import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  actions,
  can,
  createSessionCredential,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  ontology,
  prop,
  ref,
  Sixb,
  type WorkflowDefinition,
  workflows,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const sendContract = defineAction("send-contract")
  .on(Contract)
  .params({})
  .edits(() => {})

const reviewContract = defineWorkflowStep("review-contract")
  .input({ contract: ref(Contract) })
  .output({ contract: ref(Contract) })
  .run(async () => ({ contract: { objectTypeId: "contract", primaryId: "c1" } }))

// Widened to the base type so the registered array avoids the deep chain type.
const renewContract: WorkflowDefinition = defineWorkflow("renew-contract")
  .input({ contract: ref(Contract) })
  .then(reviewContract)

const commercial = defineGroup("commercial")
const operations = defineGroup("operations")
const admins = defineGroup("admins")

const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [can.view(Contract), can.apply(sendContract)],
})

const operationsRunner = defineRole("operations.runner", {
  grantedTo: [operations],
  grants: [can.start(renewContract)],
})

const adminOperator = defineRole("admin.operator", {
  grantedTo: [admins],
  grants: [can.view(ontology.objects()), can.apply(actions()), can.start(workflows())],
})

async function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Contract, Invoice],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    actions: [sendContract],
    workflows: [renewContract],
    groups: [commercial, operations, admins],
    roles: [contractOperator, operationsRunner, adminOperator],
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })

  await sixb.upsertObject("contract", { id: "c1" })
  await sixb.upsertObject("invoice", { id: "i1" })

  return { sixb, storage }
}

async function createApp(options: { readonly auth?: boolean } = {}) {
  const { sixb, storage } = await createRuntime(options)
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, storage }
}

async function seedSession(
  storage: InMemoryStorage,
  groupIds: readonly string[],
  userId = "usr_1"
) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "test-project",
    email: `${userId}@acme.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return {
    headers: { cookie: `sixb_session=${credential.cookieValue}` },
    csrfHeaders: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

describe("authorized object routes", () => {
  test("object type metadata narrows to viewable types", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")

    const operatorList = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: operator.headers })
    )
    const operatorBody = (await operatorList.json()) as {
      id: string
      actions: { id: string }[]
    }[]

    expect(operatorList.status).toBe(200)
    expect(operatorBody.map((objectType) => objectType.id)).toEqual(["contract"])
    expect(operatorBody[0].actions.map((action) => action.id)).toEqual(["send-contract"])

    const hidden = await app.fetch(
      new Request("http://localhost/api/object-types/invoice", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)

    const runnerList = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: runner.headers })
    )
    expect(await runnerList.json()).toEqual([])
  })

  test("wildcard object and action grants expose all object metadata", async () => {
    const { app, storage } = await createApp()
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const response = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: admin.headers })
    )
    const body = (await response.json()) as {
      id: string
      actions: { id: string }[]
    }[]

    expect(response.status).toBe(200)
    expect(body.map((objectType) => objectType.id)).toEqual(["contract", "invoice"])
    expect(body.find((objectType) => objectType.id === "contract")?.actions).toEqual([
      expect.objectContaining({ id: "send-contract" }),
    ])
  })

  test("broad listings narrow to the principal's viewable types", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const response = await app.fetch(
      new Request("http://localhost/api/objects", { headers: session.headers })
    )
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(body.objects.map((row) => row.objectTypeId)).toEqual(["contract"])
  })

  test("explicitly requesting a forbidden type returns 403", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const response = await app.fetch(
      new Request("http://localhost/api/objects?objectTypeId=invoice", {
        headers: session.headers,
      })
    )

    expect(response.status).toBe(403)
  })

  test("principals with no grants list nothing", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, [])

    const response = await app.fetch(
      new Request("http://localhost/api/objects", { headers: session.headers })
    )
    const body = (await response.json()) as { objects: unknown[]; total: number }

    expect(response.status).toBe(200)
    expect(body).toEqual({ objects: [], hasMore: false, total: 0 })
  })

  test("identity reads return 404 for both forbidden and missing objects", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const allowed = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1", { headers: session.headers })
    )
    expect(allowed.status).toBe(200)

    const forbidden = await app.fetch(
      new Request("http://localhost/api/objects/invoice/i1", { headers: session.headers })
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: "Object not found" })

    const missing = await app.fetch(
      new Request("http://localhost/api/objects/contract/missing", { headers: session.headers })
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Object not found" })
  })

  test("object queries deny forbidden touched types with 403", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const denied = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({ query: { kind: "start", objectTypeId: "invoice" } }),
      })
    )
    expect(denied.status).toBe(403)

    const allowed = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({
          query: {
            kind: "limit",
            input: { kind: "start", objectTypeId: "contract" },
            limit: 10,
          },
        }),
      })
    )
    expect(allowed.status).toBe(200)
    const body = (await allowed.json()) as { objects: { primaryId: string }[] }
    expect(body.objects.map((row) => row.primaryId)).toEqual(["c1"])
  })

  test("disabled auth keeps object routes privileged", async () => {
    const { app } = await createApp({ auth: false })

    const response = await app.fetch(new Request("http://localhost/api/objects"))
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(new Set(body.objects.map((row) => row.objectTypeId))).toEqual(
      new Set(["contract", "invoice"])
    )
  })
})

describe("authorized action routes", () => {
  test("action metadata narrows to applicable actions", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")

    const operatorList = await app.fetch(
      new Request("http://localhost/api/actions", { headers: operator.headers })
    )
    expect(((await operatorList.json()) as { id: string }[]).map((a) => a.id)).toEqual([
      "send-contract",
    ])

    const runnerList = await app.fetch(
      new Request("http://localhost/api/actions", { headers: runner.headers })
    )
    expect(await runnerList.json()).toEqual([])

    const hidden = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", { headers: runner.headers })
    )
    expect(hidden.status).toBe(404)
  })

  test("action requests require can.apply", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const body = JSON.stringify({
      subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
    })

    const allowed = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", {
        method: "POST",
        headers: operator.csrfHeaders,
        body,
      })
    )
    // Action requests enqueue asynchronously, so the route returns 202 Accepted.
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", {
        method: "POST",
        headers: runner.csrfHeaders,
        body,
      })
    )
    expect(denied.status).toBe(403)
  })
})

describe("authorized event and workflow routes", () => {
  test("event reads return only the events the principal may see", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")

    // The operator can view Contract, so contract events are visible.
    const operatorEvents = await app.fetch(
      new Request("http://localhost/api/events", { headers: operator.headers })
    )
    expect(operatorEvents.status).toBe(200)
    const operatorBody = (await operatorEvents.json()) as { events: { type: string }[] }
    expect(operatorBody.events.map((event) => event.type)).toContain("object.upserted")

    // The runner has no object grants, so object events are filtered out.
    const runnerEvents = await app.fetch(
      new Request("http://localhost/api/events", { headers: runner.headers })
    )
    expect(runnerEvents.status).toBe(200)
    const runnerBody = (await runnerEvents.json()) as { events: { type: string }[] }
    expect(runnerBody.events.filter((event) => event.type === "object.upserted")).toEqual([])
  })

  test("workflow runs require can.start", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const body = JSON.stringify({
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    })

    const allowed = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract/runs", {
        method: "POST",
        headers: runner.csrfHeaders,
        body,
      })
    )
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract/runs", {
        method: "POST",
        headers: operator.csrfHeaders,
        body,
      })
    )
    expect(denied.status).toBe(403)
  })
})

describe("authorized event websocket", () => {
  test("any authenticated principal may connect; events are filtered as they stream", async () => {
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const { sixb, storage } = await createRuntime()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()
    try {
      const wsUrl = `${baseUrl.replace("http://", "ws://")}/ws/events`

      // No connection-level events grant: both principals connect, and the
      // stream is filtered per-event by their grants during polling.
      const runnerWs = new WebSocket(wsUrl, { headers: runner.headers })
      expect(await nextWsMessage(runnerWs)).toEqual({ type: "connected", channel: "events" })
      runnerWs.close()

      const operatorWs = new WebSocket(wsUrl, { headers: operator.headers })
      expect(await nextWsMessage(operatorWs)).toEqual({ type: "connected", channel: "events" })
      operatorWs.close()
    } finally {
      await server.stop()
    }
  })
})

function nextWsMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String((event as MessageEvent).data))),
      { once: true }
    )
    ws.addEventListener("error", () => reject(new Error("WebSocket errored")), { once: true })
    ws.addEventListener("close", () => reject(new Error("WebSocket closed before a message")), {
      once: true,
    })
  })
}

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
