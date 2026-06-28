import { describe, expect, test } from "bun:test"
import {
  can,
  createAgentApiGatewayCapability,
  createAgentRunLeaseId,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  Sixb,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "agent-api-gateway-tests"
const NOW = new Date("2026-06-28T12:00:00.000Z")

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
})

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const agentRuntime = defineGroup("agent-runtime")
const agentRole = defineRole("agent.runtime", {
  grantedTo: [agentRuntime],
  grants: [can.view(Device)],
})

describe("agent API gateway", () => {
  test("uses normal privileged API behavior when auth is disabled", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime({ auth: false })

    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "device" }),
      expect.objectContaining({ id: "contract" }),
    ])
  })

  test("authorizes allowed API calls from the run lease capability", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime()

    const objectTypes = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/object-types`, {
        headers: {
          authorization: "Bearer attacker",
          cookie: "sixb_session=attacker",
        },
      })
    )
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([expect.objectContaining({ id: "device" })])

    const count = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/objects/query/count`, {
        method: "POST",
        headers: {
          authorization: "Bearer attacker",
          cookie: "sixb_session=attacker",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "start", objectTypeId: "device" } }),
      })
    )
    expect(count.status).toBe(200)
    await expect(count.json()).resolves.toMatchObject({ count: 1 })
  })

  test("rejects invalid capabilities and undocumented routes", async () => {
    const { app, gatewayBaseUrl, leaseId, runId, storage } = await createGatewayRuntime()

    const invalidCapability = await app.fetch(
      new Request(`http://localhost/__sixb/agent-api/${runId}/bad/api/object-types`)
    )
    expect(invalidCapability.status).toBe(403)

    const undocumentedRoute = await app.fetch(
      new Request(`http://localhost/__sixb/agent-api/${runId}/bad/api/auth/access-tokens`)
    )
    expect(undocumentedRoute.status).toBe(404)

    await storage.agents.runs.finish({
      id: runId,
      projectId: PROJECT_ID,
      leaseId,
      status: "succeeded",
      completedAt: NOW,
    })
    const finishedRun = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(finishedRun.status).toBe(403)
  })
})

async function createGatewayRuntime(options: { readonly auth?: boolean } = {}): Promise<{
  readonly app: ReturnType<typeof createSixbApi>
  readonly gatewayBaseUrl: string
  readonly leaseId: string
  readonly runId: string
  readonly storage: InMemoryStorage
}> {
  const storage = new InMemoryStorage()
  const sixb = new Sixb({
    id: PROJECT_ID,
    ontology: [Device, Contract],
    groups: [agentRuntime],
    roles: [agentRole],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })

  await sixb.upsertObject("device", { id: "fan-1", label: "Fan 1" })
  await sixb.upsertObject("contract", { id: "contract-1" })

  const serviceAccountId = "svc_agent_assistant"
  await storage.auth.serviceAccounts.create({
    id: serviceAccountId,
    projectId: PROJECT_ID,
    name: "Assistant agent",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  })
  await storage.auth.serviceAccountGroupMemberships.upsert({
    projectId: PROJECT_ID,
    serviceAccountId,
    groupId: agentRuntime.id,
    source: "agent",
    createdAt: NOW,
  })

  const threadId = "thread-1"
  const runId = "run-1"
  const lease = { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + 60_000) }
  await storage.agents.threads.create({
    id: threadId,
    projectId: PROJECT_ID,
    agentId: "assistant",
    ownerPrincipal: { type: "user", id: "usr_requester" },
    createdAt: NOW,
    updatedAt: NOW,
  })
  await storage.agents.runs.reserve({
    id: runId,
    projectId: PROJECT_ID,
    threadId,
    agentId: "assistant",
    triggerMessageId: "msg-1",
    requestedByPrincipal: { type: "user", id: "usr_requester" },
    executionPrincipal: { type: "serviceAccount", id: serviceAccountId },
    lease,
    createdAt: NOW,
    startedAt: NOW,
  })

  const capability = createAgentApiGatewayCapability({
    projectId: PROJECT_ID,
    runId,
    leaseId: lease.id,
  })
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return {
    app,
    gatewayBaseUrl: `http://localhost/__sixb/agent-api/${encodeURIComponent(
      runId
    )}/${encodeURIComponent(capability)}`,
    leaseId: lease.id,
    runId,
    storage,
  }
}
