import { describe, expect, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWorkflow,
  defineWorkflowStep,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
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

function fileRefJson(fileRef: FileRef): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(fileRef).filter((entry): entry is [string, string | number] => {
      const value = entry[1]
      return typeof value === "string" || typeof value === "number"
    })
  )
}

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
  links: [
    link("contract", Contract, {
      cardinality: "one",
      properties: [prop("relationship", "string")],
    }),
  ],
})

const labelDevice = defineAction("label-device")
  .on(Device)
  .params({})
  .edits(() => {})

const inspectDevice = defineWorkflowStep("inspect-device")
  .input({ document: "fileRef" })
  .output({ document: "fileRef" })
  .run(async ({ input }) => ({ document: input.document }))

const inspectDevices = defineWorkflow("inspect-devices")
  .input({ document: "fileRef" })
  .then(inspectDevice)

const agentRuntime = defineGroup("agent-runtime")
const agentRole = defineRole("agent.runtime", {
  grantedTo: [agentRuntime],
  grants: [can.view(Device), can.view(Contract), can.apply(labelDevice), can.run(inspectDevices)],
})

describe("agent API gateway", () => {
  test("uses normal privileged API behavior when auth is disabled", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime({ auth: false })

    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
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
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
    ])

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

  test("exposes files, links, action history, and authorized workflow runs", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime()

    const form = new FormData()
    form.set("file", new File([new Uint8Array(1_000_001)], "generated.bin"))
    const upload = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/files`, { method: "POST", body: form })
    )
    expect(upload.status).toBe(200)
    const fileRef = await upload.json()
    expect(fileRef).toMatchObject({ fileName: "generated.bin", sizeBytes: 1_000_001 })

    const links = await app.fetch(new Request(`${gatewayBaseUrl}/api/objects/device/fan-1/links`))
    expect(links.status).toBe(200)
    await expect(links.json()).resolves.toEqual([
      expect.objectContaining({
        linkId: "contract",
        targetTypeId: "contract",
        targetId: "contract-1",
        properties: { relationship: "managed" },
      }),
    ])

    const action = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/actions/label-device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: "device", primaryId: "fan-1" },
        }),
      })
    )
    expect(action.status).toBe(202)
    const actionRun = (await action.json()) as { runId: string }
    const actionRuns = await app.fetch(new Request(`${gatewayBaseUrl}/api/action-runs`))
    expect(actionRuns.status).toBe(200)
    await expect(actionRuns.json()).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: actionRun.runId, actionId: "label-device" })],
    })

    const workflows = await app.fetch(new Request(`${gatewayBaseUrl}/api/workflows`))
    expect(workflows.status).toBe(200)
    await expect(workflows.json()).resolves.toEqual([
      expect.objectContaining({ id: "inspect-devices" }),
    ])

    const workflow = await app.fetch(new Request(`${gatewayBaseUrl}/api/workflows/inspect-devices`))
    expect(workflow.status).toBe(200)

    const workflowRequest = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/workflows/inspect-devices/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { document: fileRef } }),
      })
    )
    expect(workflowRequest.status).toBe(202)
    const workflowRun = (await workflowRequest.json()) as { runId: string }

    const workflowRuns = await app.fetch(new Request(`${gatewayBaseUrl}/api/workflow-runs`))
    expect(workflowRuns.status).toBe(200)
    const workflowRunHistory = (await workflowRuns.json()) as { runs: readonly unknown[] }
    expect(workflowRunHistory.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: workflowRun.runId, workflowId: "inspect-devices" }),
      ])
    )

    const workflowDetail = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/workflow-runs/${workflowRun.runId}`)
    )
    expect(workflowDetail.status).toBe(200)
    await expect(workflowDetail.json()).resolves.toEqual({
      run: expect.objectContaining({ id: workflowRun.runId, status: "queued" }),
      nodes: [],
    })

    const workflowFile = await app.fetch(
      new Request(
        `${gatewayBaseUrl}/api/workflow-runs/${workflowRun.runId}/files/content?path=${encodeURIComponent("/input/document")}`
      )
    )
    expect(workflowFile.status).toBe(200)
    expect((await workflowFile.arrayBuffer()).byteLength).toBe(1_000_001)

    const completedDetail = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/workflow-runs/completed-workflow-run`)
    )
    expect(completedDetail.status).toBe(200)
    await expect(completedDetail.json()).resolves.toEqual({
      run: expect.objectContaining({
        id: "completed-workflow-run",
        status: "succeeded",
        output: {
          document: expect.objectContaining({ fileName: "workflow-result.txt" }),
        },
      }),
      nodes: [],
    })

    const completedFile = await app.fetch(
      new Request(
        `${gatewayBaseUrl}/api/workflow-runs/completed-workflow-run/files/content?path=${encodeURIComponent("/output/document")}`
      )
    )
    expect(completedFile.status).toBe(200)
    expect(await completedFile.text()).toBe("workflow result")
  })

  test("keeps the general body limit and rejects recursive workflow starts", async () => {
    const conversational = await createGatewayRuntime()
    const oversizedQuery = await conversational.app.fetch(
      new Request(`${conversational.gatewayBaseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1_000_001) }),
      })
    )
    expect(oversizedQuery.status).toBe(413)
    await expect(oversizedQuery.json()).resolves.toEqual({
      error: "Agent API gateway request body exceeds 1MB.",
    })

    const workflowAgent = await createGatewayRuntime({ executionKind: "workflow" })
    const recursive = await workflowAgent.app.fetch(
      new Request(`${workflowAgent.gatewayBaseUrl}/api/workflows/inspect-devices/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    )
    expect(recursive.status).toBe(409)
    await expect(recursive.json()).resolves.toEqual({
      error: "Workflow agent nodes cannot start another workflow run.",
    })

    const discover = await workflowAgent.app.fetch(
      new Request(`${workflowAgent.gatewayBaseUrl}/api/workflows`)
    )
    expect(discover.status).toBe(200)
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

    for (const request of [
      new Request(`${gatewayBaseUrl}/api/objects/device/fan-1`, { method: "PUT", body: "{}" }),
      new Request(`${gatewayBaseUrl}/api/objects/device/fan-1/links/contract`, {
        method: "PUT",
        body: "{}",
      }),
      new Request(`${gatewayBaseUrl}/api/objects/device/fan-1/telemetry/temperature`, {
        method: "POST",
        body: "{}",
      }),
      new Request(`${gatewayBaseUrl}/api/workflow-runs/completed-workflow-run/cancel`, {
        method: "POST",
        body: "{}",
      }),
      new Request(
        `${gatewayBaseUrl}/api/workflow-runs/completed-workflow-run/nodes/inspectDevice/files/content?path=/output/document`
      ),
    ]) {
      const response = await app.fetch(request)
      expect(response.status).toBe(404)
    }

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
  options: {
    readonly auth?: boolean
    readonly executionKind?: "conversation" | "workflow"
    readonly queueLeaseExpiresAt?: Date
  } = {}
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
    ontology: [Contract, Device],
    actions: [labelDevice],
    workflows: [inspectDevices],
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
  await sixb.upsertLink("device", "fan-1", "contract", {
    targetTypeId: "contract",
    targetId: "contract-1",
    properties: { relationship: "managed" },
  })

  const completedWorkflowOutput = await sixb.blobStorage.put({
    body: new TextEncoder().encode("workflow result"),
    fileName: "workflow-result.txt",
    mediaType: "text/plain",
  })
  await storage.workflowRuns.start({
    id: "completed-workflow-run",
    projectId: PROJECT_ID,
    workflowId: inspectDevices.id,
    input: { document: fileRefJson(completedWorkflowOutput) },
    startedAt: NOW,
  })
  await storage.workflowRuns.nodes.start({
    id: "completed-workflow-node",
    projectId: PROJECT_ID,
    workflowRunId: "completed-workflow-run",
    workflowId: inspectDevices.id,
    nodeIndex: 0,
    nodeType: "step",
    nodeId: inspectDevice.id,
    nodeKey: "inspectDevice",
    input: { document: fileRefJson(completedWorkflowOutput) },
    startedAt: NOW,
  })
  await storage.workflowRuns.nodes.finish({
    id: "completed-workflow-node",
    projectId: PROJECT_ID,
    status: "succeeded",
    output: { document: fileRefJson(completedWorkflowOutput) },
    finishedAt: NOW,
  })
  await storage.workflowRuns.finish({
    id: "completed-workflow-run",
    projectId: PROJECT_ID,
    status: "succeeded",
    finishedAt: NOW,
  })

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
  const runId = options.executionKind === "workflow" ? "workflow-node-1" : "run-1"
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: options.queueLeaseExpiresAt ?? new Date(Date.now() + 60_000),
  }
  if (options.executionKind === "workflow") {
    await storage.workflowRuns.start({
      id: "parent-workflow-run",
      projectId: PROJECT_ID,
      workflowId: inspectDevices.id,
      input: {},
      startedAt: NOW,
    })
    await storage.workflowRuns.nodes.start({
      id: runId,
      projectId: PROJECT_ID,
      workflowRunId: "parent-workflow-run",
      workflowId: inspectDevices.id,
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: "nested-agent",
      nodeKey: "nestedAgent",
      input: {},
      startedAt: NOW,
    })
    await storage.workflowRuns.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId: runId,
      agentId: "assistant",
      prompt: "Inspect devices.",
      createdAt: NOW,
    })
    await storage.workflowRuns.agentNodes.start({
      projectId: PROJECT_ID,
      nodeRunId: runId,
      executionPrincipal: { type: "serviceAccount", id: serviceAccountId },
      execution,
      startedAt: NOW,
    })
  } else {
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
  }

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
