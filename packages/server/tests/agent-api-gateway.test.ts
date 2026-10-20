import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWorkflow,
  defineWorkflowStep,
  type EmbeddingModel,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  prop,
  SixbHost,
  SYSTEM_PRINCIPAL,
} from "@sixb/core"
import { createInheritedAgentExecutionRecord } from "@sixb/core/internal/agent-execution"
import {
  createAgentApiGatewayCapability,
  createAgentRunExecutionToken,
} from "@sixb/core/internal/agents"
import {
  createTestAgentExecution,
  createTestSixb,
  createTestWorkflowExecution,
} from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const PROJECT_ID = "agent-api-gateway-tests"
const NOW = new Date("2026-06-28T12:00:00.000Z")
const AGENT_CLI_ARTIFACT = resolve(
  import.meta.dir,
  "../../agent-worker/src/agent-cli/generated/sixb.mjs"
)

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

// Every search text costs 7 input tokens, so usage rows and limit consumption are exact.
const deviceEmbeddings: EmbeddingModel = {
  providerId: "test",
  modelId: "device-embeddings",
  definition: {
    kind: "embedding",
    providerId: "test",
    modelId: "device-embeddings",
    dimensions: 3,
  },
  async embed({ texts }) {
    return { vectors: texts.map(() => [1, 0, 0]), usage: { inputTokens: 7 } }
  },
}

const Device = defineObjectType({
  id: "device",
  name: "Device",
  properties: [prop("id", "string", { required: true, primary: true }), prop("label", "string")],
  search: { vectors: { content: { source: ["label"], model: deviceEmbeddings } } },
  links: [
    link("contract", Contract, {
      cardinality: "one",
      properties: [prop("relationship", "string")],
    }),
  ],
})

const PrivateNote = defineObjectType({
  id: "private-note",
  name: "Private Note",
  properties: [prop("id", "string", { required: true, primary: true })],
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

// The workflow's requester can read notes; its AI task cannot. Nothing a task's request starts may
// widen the task's access to its requester's.
const noteReaders = defineGroup("note-readers")
const noteReaderRole = defineRole("note.reader", {
  grantedTo: [noteReaders],
  grants: [can.view(PrivateNote)],
})

describe("agent API gateway", () => {
  test("uses normal privileged API behavior when auth is disabled", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime({ auth: false })

    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    // The run's auth-disabled execution stays unrestricted: the Agent role deliberately cannot
    // view PrivateNote, so resolving this run as a principal would hide it.
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
      expect.objectContaining({ id: "private-note" }),
    ])
  })

  test("restores the run's inherited user authority from its capability, not caller credentials", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime()

    const objectTypes = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/object-types`, {
        headers: {
          authorization: "Bearer attacker",
          cookie: "sixb_session_app=attacker",
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
          cookie: "sixb_session_app=attacker",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "start", objectTypeId: "device" } }),
      })
    )
    expect(count.status).toBe(200)
    await expect(count.json()).resolves.toMatchObject({ count: 1 })
  })

  test("restores child authority without allowing recursive workflows", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime({ executionKind: "subagent" })

    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
    ])

    const workflow = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/workflows/inspect-devices/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    )
    expect(workflow.status).toBe(409)
    await expect(workflow.json()).resolves.toEqual({
      error: "Child agents cannot start a workflow run.",
    })
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

    const queriedLinks = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/objects/query/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "device", primaryId: "fan-1" }],
          },
          direction: "outgoing",
          includeObjects: true,
        }),
      })
    )
    expect(queriedLinks.status).toBe(200)
    await expect(queriedLinks.json()).resolves.toMatchObject({
      objects: [
        { objectTypeId: "device", primaryId: "fan-1" },
        { objectTypeId: "contract", primaryId: "contract-1" },
      ],
      links: [
        {
          source: { objectTypeId: "device", primaryId: "fan-1" },
          linkId: "contract",
          target: { objectTypeId: "contract", primaryId: "contract-1" },
        },
      ],
    })

    const action = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/actions/label-device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: "device", primaryId: "fan-1" },
        }),
      })
    )
    expect(action.status).toBe(200)
    const actionRun = (await action.json()) as { id: string }
    expect(actionRun).toMatchObject({ actionId: "label-device", status: "succeeded" })
    const actionRuns = await app.fetch(new Request(`${gatewayBaseUrl}/api/action-runs`))
    expect(actionRuns.status).toBe(200)
    await expect(actionRuns.json()).resolves.toMatchObject({
      runs: [expect.objectContaining({ id: actionRun.id, actionId: "label-device" })],
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

  test("keeps the generated agent CLI compatible with the real gateway", async () => {
    const { app, gatewayBaseUrl } = await createGatewayRuntime()
    const directory = await mkdtemp(join(tmpdir(), "sixb-agent-cli-gateway-"))
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => app.fetch(request),
    })
    const baseUrl = new URL(gatewayBaseUrl)
    baseUrl.hostname = "127.0.0.1"
    baseUrl.port = String(listener.port)

    try {
      const cli = (args: readonly string[]) => runAgentCli(baseUrl.href, args)
      const invalidQueryPath = join(directory, "invalid-query.json")
      const actionParamsPath = join(directory, "action-params.json")
      const uploadPath = join(directory, "upload.txt")
      const downloadPath = join(directory, "download.txt")
      await Promise.all([
        writeFile(invalidQueryPath, JSON.stringify({ kind: "start" })),
        writeFile(actionParamsPath, "{}"),
        writeFile(uploadPath, "uploaded through the agent CLI"),
      ])

      // Each process is independent of the others in its round, so a round runs concurrently.
      const [
        project,
        ontology,
        objects,
        objectList,
        graph,
        invalidQuery,
        action,
        upload,
        download,
      ] = await Promise.all([
        cli(["project", "show"]),
        cli(["ontology", "get", "device"]),
        cli(["objects", "get", "device", "fan-1"]),
        cli(["objects", "list", "--type", "device"]),
        cli(["objects", "inspect", "device", "fan-1", "--depth", "1"]),
        cli(["objects", "query", "--file", invalidQueryPath]),
        cli([
          "actions",
          "request",
          "label-device",
          "--subject-type",
          "device",
          "--subject-id",
          "fan-1",
          "--file",
          actionParamsPath,
        ]),
        cli(["files", "upload", uploadPath]),
        cli([
          "files",
          "download",
          "workflow-run",
          "completed-workflow-run",
          "--path",
          "/output/document",
          "--output",
          downloadPath,
        ]),
      ])

      expect(project.exitCode).toBe(0)
      expect(JSON.parse(project.stdout)).toMatchObject({ id: PROJECT_ID })

      expect(ontology.exitCode).toBe(0)
      expect(JSON.parse(ontology.stdout)).toMatchObject({
        id: "device",
        links: [expect.objectContaining({ id: "contract" })],
      })

      expect(objects.exitCode).toBe(0)
      expect(JSON.parse(objects.stdout)).toMatchObject({
        objects: [expect.objectContaining({ objectTypeId: "device", primaryId: "fan-1" })],
      })

      expect(objectList.exitCode).toBe(0)
      expect(JSON.parse(objectList.stdout)).toMatchObject({
        objects: [expect.objectContaining({ objectTypeId: "device", primaryId: "fan-1" })],
        hasMore: false,
      })

      expect(graph.exitCode).toBe(0)
      expect(JSON.parse(graph.stdout)).toMatchObject({
        object: { objectTypeId: "device", primaryId: "fan-1" },
        relatedObjects: expect.arrayContaining([
          expect.objectContaining({ objectTypeId: "contract", primaryId: "contract-1" }),
        ]),
        links: [
          expect.objectContaining({
            sourceTypeId: "device",
            sourceId: "fan-1",
            linkId: "contract",
            targetTypeId: "contract",
            targetId: "contract-1",
          }),
        ],
      })

      expect(invalidQuery.exitCode).toBe(3)
      expect(JSON.parse(invalidQuery.stderr)).toMatchObject({
        error: {
          code: "http_error",
          status: 400,
          issues: [
            expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String),
              path: expect.any(String),
            }),
          ],
        },
      })

      expect(action.exitCode).toBe(0)
      const actionResult = JSON.parse(action.stdout) as { id: string }
      expect(actionResult).toMatchObject({
        id: expect.any(String),
        actionId: "label-device",
        status: "succeeded",
      })

      expect(upload.exitCode).toBe(0)
      const uploadedFile = JSON.parse(upload.stdout)
      expect(uploadedFile).toMatchObject({
        fileName: "upload.txt",
        sizeBytes: 30,
      })

      expect(download.exitCode).toBe(0)
      expect(JSON.parse(download.stdout)).toEqual({ downloaded: true, output: downloadPath })
      expect(await readFile(downloadPath, "utf8")).toBe("workflow result")

      const workflowInputPath = join(directory, "workflow-input.json")
      await writeFile(workflowInputPath, JSON.stringify({ document: uploadedFile }))
      const [actionRuns, workflow] = await Promise.all([
        cli(["action-runs", "list", "--action", "label-device"]),
        cli(["workflows", "start", "inspect-devices", "--file", workflowInputPath]),
      ])

      expect(actionRuns.exitCode).toBe(0)
      expect(JSON.parse(actionRuns.stdout)).toMatchObject({
        runs: [expect.objectContaining({ id: actionResult.id, actionId: "label-device" })],
        hasMore: false,
      })

      expect(workflow.exitCode).toBe(0)
      expect(JSON.parse(workflow.stdout)).toMatchObject({
        runId: expect.any(String),
        workflowId: "inspect-devices",
      })
    } finally {
      listener.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  })
})

// Removal proof: bind gateway requests with `bindRequestExecution` again in server.ts and every test
// here fails — what a request starts gets a fresh root `http` execution as parent, a new correlation
// id, and the agent's service account as requester for a workflow AI task.
describe("runs gateway requests inside the agent run's execution", () => {
  test("keeps a conversation's requester and correlation on the actions it requests", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime()
    const agentExecution = await executionById(storage, agentExecutionId)

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl)

    await expect(actionRunExecution(storage, actionRunId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      requestedBy: { type: "user", id: "usr_requester" },
      correlationId: "request-main",
      requesterGroupIds: agentExecution.requesterGroupIds,
    })
  })

  test("makes a subagent's actions children of the subagent's execution", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime({
      executionKind: "subagent",
    })

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl)

    await expect(actionRunExecution(storage, actionRunId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      requestedBy: { type: "user", id: "usr_requester" },
      correlationId: "request-main",
    })
  })

  test("keeps the workflow's requester while a workflow AI task keeps its own access", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime({
      executionKind: "workflow",
    })

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl)

    await expect(actionRunExecution(storage, actionRunId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      requestedBy: { type: "user", id: "usr_requester" },
      correlationId: "test_correlation:parent-workflow-run",
    })

    // The requester can view notes; the task's groups cannot, and they still decide.
    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
    ])
  })

  test("makes a workflow a conversation starts a child of the agent's execution", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, sixb, storage } = await createGatewayRuntime()
    const document = await sixb.blobStorage.put({
      body: new TextEncoder().encode("device report"),
      fileName: "report.txt",
      mediaType: "text/plain",
    })

    const response = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/workflows/inspect-devices/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { document: fileRefJson(document) } }),
      })
    )
    expect(response.status).toBe(202)
    const { runId } = (await response.json()) as { runId: string }

    const workflowRun = await storage.workflowRuns.getById({ projectId: PROJECT_ID, id: runId })
    if (!workflowRun) throw new Error("Expected the requested workflow run.")
    await expect(executionById(storage, workflowRun.executionId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      requestedBy: { type: "user", id: "usr_requester" },
      correlationId: "request-main",
    })
  })

  test("ignores request and correlation ids the caller sends", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime()

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl, {
      "x-correlation-id": "forged-correlation",
      "x-request-id": "forged-request",
    })

    await expect(actionRunExecution(storage, actionRunId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      correlationId: "request-main",
    })
  })

  // Removal proof: pass `attempt: 1` instead of the run's attempt to
  // bindModelExecutionAttempt in bindAgentGatewayRequestExecution and the usage row's attempt is 1.
  test("accounts a search's embedding to the run's execution, attempt and requester", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime({
      executionKind: "workflow",
      attempt: 2,
    })
    for (const [id, subject] of [
      ["limit-requester", { type: "user", id: "usr_requester" }],
      ["limit-agent", { type: "serviceAccount", id: "svc_agent_assistant" }],
    ] as const) {
      await storage.aiLimits.createPolicy({
        id,
        projectId: PROJECT_ID,
        subject,
        limit: { meter: "tokens.total", amount: 1_000 },
      })
    }

    const search = await app.fetch(
      new Request(`${gatewayBaseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: deviceSearchQuery() }),
      })
    )
    expect(search.status).toBe(200)

    await expect(
      storage.aiUsage.getLatestForExecution({
        projectId: PROJECT_ID,
        executionId: agentExecutionId,
      })
    ).resolves.toMatchObject({
      executionId: agentExecutionId,
      attempt: 2,
      usage: { inputTokens: 7 },
    })

    // The limit subject is the workflow's requester, not the task's service account.
    const statuses = await storage.aiLimits.listPolicyStatuses({ projectId: PROJECT_ID })
    const consumed = Object.fromEntries(
      statuses.map((status) => [status.policy.id, status.consumption.actual])
    )
    expect(consumed).toEqual({
      "limit-requester": { meter: "tokens.total", amount: 7 },
      "limit-agent": { meter: "tokens.total", amount: 0 },
    })
  })

  // Removal proof: build the forwarded request without the caller's `signal` in
  // handleAgentApiGatewayRequest and the embedding runs to its own timeout, never aborted.
  test("cancels the forwarded work when the caller aborts", async () => {
    let embedding: AbortSignal | undefined
    let embeddingStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      embeddingStarted = resolve
    })
    const { app, gatewayBaseUrl } = await createGatewayRuntime({
      embed: async ({ texts, signal }) => {
        embedding = signal
        embeddingStarted()
        await abortedOrTimedOut(signal, 2_000)
        return { vectors: texts.map(() => [1, 0, 0]), usage: { inputTokens: 7 } }
      },
    })

    const caller = new AbortController()
    const response = app.fetch(
      new Request(`${gatewayBaseUrl}/api/objects/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: deviceSearchQuery() }),
        signal: caller.signal,
      })
    )
    await started
    caller.abort()
    await Promise.resolve(response).catch(() => undefined)

    expect(embedding?.aborted).toBe(true)
  })

  // Removal proof: restore the `!host.auth.isEnabled()` shortcut in resolveAgentRunAuthState and
  // both fail — the request becomes a root auth-disabled request, unrestricted for a workflow task.
  test("keeps an auth-disabled conversation unrestricted inside its execution", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime({
      auth: false,
    })

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl)

    const execution = await actionRunExecution(storage, actionRunId)
    expect(execution).toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      correlationId: "request-main",
    })
    expect(execution.requestedBy).toBeUndefined()
  })

  test("limits an auth-disabled workflow AI task to its groups", async () => {
    const { app, gatewayBaseUrl, agentExecutionId, storage } = await createGatewayRuntime({
      auth: false,
      executionKind: "workflow",
    })

    const objectTypes = await app.fetch(new Request(`${gatewayBaseUrl}/api/object-types`))
    expect(objectTypes.status).toBe(200)
    await expect(objectTypes.json()).resolves.toEqual([
      expect.objectContaining({ id: "contract" }),
      expect.objectContaining({ id: "device" }),
    ])

    const actionRunId = await labelDeviceThroughGateway(app, gatewayBaseUrl)
    await expect(actionRunExecution(storage, actionRunId)).resolves.toMatchObject({
      source: { type: "execution", executionId: agentExecutionId },
      requestedBy: { type: "user", id: "usr_requester" },
    })
  })
})

function deviceSearchQuery() {
  return {
    kind: "vector",
    input: { kind: "start", objectTypeId: "device" },
    profile: "content",
    vector: "fan",
    k: 1,
  }
}

/** Resolve once the signal aborts, or after `timeoutMs` so a missed abort cannot hang the test. */
function abortedOrTimedOut(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

async function labelDeviceThroughGateway(
  app: ReturnType<typeof createSixbApi>,
  gatewayBaseUrl: string,
  headers: Readonly<Record<string, string>> = {}
): Promise<string> {
  const response = await app.fetch(
    new Request(`${gatewayBaseUrl}/api/actions/label-device`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        subject: { kind: "object", objectTypeId: "device", primaryId: "fan-1" },
      }),
    })
  )
  expect(response.status).toBe(200)

  const run = (await response.json()) as { id: string }
  return run.id
}

async function actionRunExecution(storage: InMemoryStorage, actionRunId: string) {
  const run = await storage.actionRuns.getById({ projectId: PROJECT_ID, id: actionRunId })
  if (!run) throw new Error(`Expected action run '${actionRunId}'.`)

  return executionById(storage, run.executionId)
}

async function executionById(storage: InMemoryStorage, id: string) {
  const execution = await storage.executions.getById({ projectId: PROJECT_ID, id })
  if (!execution) throw new Error(`Expected execution '${id}'.`)

  return execution
}

async function runAgentCli(
  baseUrl: string,
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  // This path-level dependency is intentional: it verifies the exact artifact copied into agent
  // sandboxes without making @sixb/agent-worker a runtime dependency of @sixb/server.
  const child = Bun.spawn([process.execPath, AGENT_CLI_ARTIFACT, ...args], {
    env: { ...Bun.env, SIXB_API_BASE_URL: baseUrl },
    stdout: "pipe",
    stderr: "pipe",
  })
  // Bound each process so a wedged CLI fails this test instead of stalling the suite.
  const killer = setTimeout(() => child.kill(), 10_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(killer)
  }
}

async function createGatewayRuntime(
  options: {
    readonly auth?: boolean
    readonly executionKind?: "conversation" | "subagent" | "workflow"
    readonly queueLeaseExpiresAt?: Date
    /** A workflow AI task's delivery attempt: above 1, the task was redelivered. */
    readonly attempt?: number
    /** Replaces how the device embedding model embeds, keeping its identity. */
    readonly embed?: EmbeddingModel["embed"]
  } = {}
): Promise<{
  readonly app: ReturnType<typeof createSixbApi>
  readonly gatewayBaseUrl: string
  readonly executionToken: string
  readonly runId: string
  readonly agentExecutionId: string
  readonly storage: InMemoryStorage
  readonly sixb: SixbHost
}> {
  const storage = new InMemoryStorage()
  const sixb = new SixbHost({
    id: PROJECT_ID,
    ontology: [Contract, Device, PrivateNote],
    actions: [labelDevice],
    workflows: [inspectDevices],
    groups: [agentRuntime, noteReaders],
    roles: [agentRole, noteReaderRole],
    models: {
      embedding: [options.embed ? { ...deviceEmbeddings, embed: options.embed } : deviceEmbeddings],
    },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })

  const setup = createTestSixb(sixb)
  await setup.objects.upsert("device", { id: "fan-1", label: "Fan 1" })
  await setup.objects.upsert("contract", { id: "contract-1" })
  await setup.objects.upsertLink("device", "fan-1", "contract", {
    targetTypeId: "contract",
    targetId: "contract-1",
    properties: { relationship: "managed" },
  })

  const completedWorkflowOutput = await sixb.blobStorage.put({
    body: new TextEncoder().encode("workflow result"),
    fileName: "workflow-result.txt",
    mediaType: "text/plain",
  })
  const completedWorkflowExecutionId = await createTestWorkflowExecution(storage.executions, {
    projectId: PROJECT_ID,
    workflowId: inspectDevices.id,
    runId: "completed-workflow-run",
  })
  await storage.workflowRuns.queue({
    id: "completed-workflow-run",
    projectId: PROJECT_ID,
    executionId: completedWorkflowExecutionId,
    workflowId: inspectDevices.id,
    input: { document: fileRefJson(completedWorkflowOutput) },
    queuedAt: NOW,
  })
  await storage.workflowRuns.start({
    id: "completed-workflow-run",
    projectId: PROJECT_ID,
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
    output: { document: fileRefJson(completedWorkflowOutput) },
    finishedAt: NOW,
  })

  if (options.executionKind === "workflow") {
    const serviceAccountId = "svc_agent_assistant"
    await storage.auth.serviceAccounts.create({
      id: serviceAccountId,
      projectId: PROJECT_ID,
      name: "Assistant agent",
      status: "active",
      createdByPrincipal: SYSTEM_PRINCIPAL,
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
  }

  const threadId = "thread-1"
  const runId =
    options.executionKind === "workflow"
      ? "workflow-node-1"
      : options.executionKind === "subagent"
        ? "child-run-1"
        : "run-1"
  const execution = {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: options.queueLeaseExpiresAt ?? new Date(Date.now() + 60_000),
  }
  let agentExecutionId: string
  if (options.executionKind === "workflow") {
    await storage.auth.users.create({
      id: "usr_requester",
      projectId: PROJECT_ID,
      email: "requester@example.com",
      createdAt: NOW,
      updatedAt: NOW,
    })
    await storage.auth.groupMemberships.upsert({
      projectId: PROJECT_ID,
      userId: "usr_requester",
      groupId: noteReaders.id,
      source: "manual",
      createdAt: NOW,
    })
    const parentWorkflowExecutionId = await createTestWorkflowExecution(storage.executions, {
      projectId: PROJECT_ID,
      workflowId: inspectDevices.id,
      runId: "parent-workflow-run",
      requestedBy: { type: "user", id: "usr_requester" },
    })
    await storage.workflowRuns.queue({
      id: "parent-workflow-run",
      projectId: PROJECT_ID,
      executionId: parentWorkflowExecutionId,
      workflowId: inspectDevices.id,
      input: {},
      queuedAt: NOW,
    })
    await storage.workflowRuns.start({
      id: "parent-workflow-run",
      projectId: PROJECT_ID,
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
    agentExecutionId = await createTestAgentExecution(storage, {
      projectId: PROJECT_ID,
      actorId: "assistant",
      runId,
      sourceExecutionId: parentWorkflowExecutionId,
    })
    await storage.workflowRuns.agentNodes.create({
      projectId: PROJECT_ID,
      nodeRunId: runId,
      executionId: agentExecutionId,
      actorId: "assistant",
      prompt: "Inspect devices.",
      createdAt: NOW,
    })
    await storage.workflowRuns.agentNodes.start({
      projectId: PROJECT_ID,
      nodeRunId: runId,
      execution,
      startedAt: NOW,
    })
    for (let attempt = 1; attempt < (options.attempt ?? 1); attempt += 1) {
      await storage.workflowRuns.agentNodes.reclaim({
        projectId: PROJECT_ID,
        nodeRunId: runId,
        execution,
      })
    }
  } else if (options.executionKind === "subagent") {
    const parentRunId = "parent-run-1"
    const parentExecutionId = await createMainAgentExecution(storage, parentRunId, options)
    const parentExecution = {
      token: createAgentRunExecutionToken(),
      queueLeaseExpiresAt: new Date(Date.now() + 60_000),
    }
    await storage.agents.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: { type: "user", id: "usr_requester" },
      createdAt: NOW,
      updatedAt: NOW,
    })
    await storage.agents.runs.create({
      id: parentRunId,
      projectId: PROJECT_ID,
      executionId: parentExecutionId,
      threadId,
      triggerMessageId: "msg-1",
      spec: { model: { provider: "test", modelId: "test-model" } },
      createdAt: NOW,
    })
    await storage.agents.runs.start({
      id: parentRunId,
      projectId: PROJECT_ID,
      execution: parentExecution,
      startedAt: NOW,
    })
    const parent = await storage.executions.getById({
      projectId: PROJECT_ID,
      id: parentExecutionId,
    })
    if (!parent) throw new Error("Expected the parent Agent execution.")
    agentExecutionId = "execution-child-agent"
    await storage.executions.create(
      createInheritedAgentExecutionRecord({ id: agentExecutionId, parent, runId })
    )
    await storage.agents.runs.createSubagent({
      id: runId,
      projectId: PROJECT_ID,
      executionId: agentExecutionId,
      parentRunId,
      parentExecutionToken: parentExecution.token,
      spawnKey: "inspect",
      spec: {
        model: { provider: "test", modelId: "child" },
        task: "Inspect devices.",
        toolNames: [],
        maxSteps: 25,
      },
      maxActiveChildren: 4,
      createdAt: NOW,
    })
    await storage.agents.runs.start({
      id: runId,
      projectId: PROJECT_ID,
      execution,
      startedAt: NOW,
    })
  } else {
    await storage.agents.threads.create({
      id: threadId,
      projectId: PROJECT_ID,
      ownerPrincipal: { type: "user", id: "usr_requester" },
      createdAt: NOW,
      updatedAt: NOW,
    })
    agentExecutionId = await createMainAgentExecution(storage, runId, options)
    await storage.agents.runs.create({
      id: runId,
      projectId: PROJECT_ID,
      executionId: agentExecutionId,
      threadId,
      triggerMessageId: "msg-1",
      spec: { model: { provider: "test", modelId: "test-model" } },
      createdAt: NOW,
    })
    await storage.agents.runs.start({
      id: runId,
      projectId: PROJECT_ID,
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
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return {
    app,
    gatewayBaseUrl: `http://localhost/__sixb/agent-api/${encodeURIComponent(
      runId
    )}/${encodeURIComponent(capability)}`,
    executionToken: execution.token,
    runId,
    agentExecutionId,
    storage,
    sixb,
  }
}

async function createMainAgentExecution(
  storage: InMemoryStorage,
  runId: string,
  options: { readonly auth?: boolean }
): Promise<string> {
  const executionId = "execution-agent"
  if (options.auth === false) {
    const parent = await storage.executions.create({
      id: "execution-main-request",
      projectId: PROJECT_ID,
      requesterGroupIds: [],
      executor: { type: "request", requestId: "request-main" },
      source: { type: "http", requestId: "request-main" },
      correlationId: "request-main",
      authorizationRef: { type: "disabled" },
    })
    await storage.executions.create(
      createInheritedAgentExecutionRecord({ id: executionId, parent, runId })
    )
    return executionId
  }

  const userId = "usr_requester"
  const sessionId = "session-agent"
  await storage.auth.users.create({
    id: userId,
    projectId: PROJECT_ID,
    email: "requester@example.com",
    createdAt: NOW,
    updatedAt: NOW,
  })
  await storage.auth.groupMemberships.upsert({
    projectId: PROJECT_ID,
    userId,
    groupId: agentRuntime.id,
    source: "manual",
    createdAt: NOW,
  })
  await storage.auth.sessions.create({
    id: sessionId,
    projectId: PROJECT_ID,
    userId,
    strategyId: "test",
    tokenHash: "not-used-after-admission",
    createdAt: NOW,
    expiresAt: new Date("2027-06-28T12:00:00.000Z"),
  })
  const parent = await storage.executions.create({
    id: "execution-main-request",
    projectId: PROJECT_ID,
    requestedBy: { type: "user", id: userId },
    requesterGroupIds: [agentRuntime.id],
    executor: { type: "request", requestId: "request-main" },
    source: { type: "http", requestId: "request-main" },
    correlationId: "request-main",
    authorizationRef: {
      type: "principal",
      principal: { type: "user", id: userId },
      credential: { type: "session", id: sessionId },
    },
  })
  await storage.executions.create(
    createInheritedAgentExecutionRecord({ id: executionId, parent, runId })
  )
  return executionId
}
