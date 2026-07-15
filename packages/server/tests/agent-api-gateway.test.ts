import { describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import {
  createAgentApiGatewayCapability,
  createAgentRunExecutionToken,
} from "@sixb/core/internal/agents"
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

  test("authorizes allowed API calls from the run execution capability", async () => {
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

  test("can fetch file attachments from the active run thread", async () => {
    const { app, gatewayBaseUrl, sixb, storage } = await createGatewayRuntime()
    const fileRef = await sixb.blobStorage.put({
      body: new TextEncoder().encode("agent attachment"),
      fileName: "attachment.txt",
      mediaType: "text/plain",
    })
    await storage.agents.messages.append({
      id: "msg-1",
      projectId: PROJECT_ID,
      threadId: "thread-1",
      runId: null,
      role: "user",
      parts: [
        { type: "text", text: "read this" },
        { type: "file", fileRef },
      ],
      authorPrincipal: { type: "user", id: "usr_requester" },
      createdAt: NOW,
    })

    const response = await app.fetch(
      new Request(
        `${gatewayBaseUrl}/api/agent-threads/thread-1/messages/msg-1/files/content?path=${encodeURIComponent("/parts/1/fileRef")}`
      )
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(await response.text()).toBe("agent attachment")
  })

  test("rejects a capability after its projected queue ownership expires", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime({
      queueLeaseExpiresAt: new Date(Date.now() - 1),
    })

    const response = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(response.status).toBe(403)
  })

  test("rejects invalid capabilities and undocumented routes", async () => {
    const { app, executionToken, gatewayBaseUrl, runId, storage } = await createGatewayRuntime()

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
      executionToken,
      status: "succeeded",
      completedAt: NOW,
    })
    const finishedRun = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(finishedRun.status).toBe(403)
  })
})

async function createGatewayRuntime(
  options: { readonly auth?: boolean; readonly queueLeaseExpiresAt?: Date } = {}
): Promise<{
  readonly app: ReturnType<typeof createSixbApi>
  readonly gatewayBaseUrl: string
  readonly executionToken: string
  readonly runId: string
  readonly storage: InMemoryStorage
  readonly sixb: Sixb<readonly OntologySource[]>
}> {
  const storage = new InMemoryStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
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
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: options.queueLeaseExpiresAt ?? new Date(Date.now() + 60_000),
  }
  await storage.agents.threads.create({
    id: threadId,
    projectId: PROJECT_ID,
    agentId: "assistant",
    ownerPrincipal: { type: "user", id: "usr_requester" },
    createdAt: NOW,
    updatedAt: NOW,
  })
  await storage.agents.runs.create({
    id: runId,
    projectId: PROJECT_ID,
    threadId,
    agentId: "assistant",
    triggerMessageId: "msg-1",
    requestedByPrincipal: { type: "user", id: "usr_requester" },
    createdAt: NOW,
  })
  await storage.agents.runs.start({
    id: runId,
    projectId: PROJECT_ID,
    executionPrincipal: { type: "serviceAccount", id: serviceAccountId },
    execution,
    startedAt: NOW,
  })

  const capability = createAgentApiGatewayCapability({
    projectId: PROJECT_ID,
    runId,
    executionToken: execution.token,
  })
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return {
    app,
    gatewayBaseUrl: `http://localhost/__sixb/agent-api/${encodeURIComponent(
      runId
    )}/${encodeURIComponent(capability)}`,
    executionToken: execution.token,
    runId,
    storage,
    sixb,
  }
}
