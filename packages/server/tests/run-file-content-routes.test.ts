import { describe, expect, test } from "bun:test"
import {
  can,
  createSessionCredential,
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
  type OntologySource,
  prop,
  Sixb,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Document = defineObjectType({
  id: "document",
  name: "Document",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const extractDocument = defineAction("extract-document")
  .on(Document)
  .params({})
  .edits(() => {})

const inspectDocumentStep = defineWorkflowStep("inspect-document-step")
  .input({})
  .output({})
  .run(async () => ({}))

const inspectDocumentWorkflow = defineWorkflow("inspect-document-workflow")
  .input({})
  .then(inspectDocumentStep)

const runFileViewers = defineGroup("run-file-viewers")
const runFileViewerRole = defineRole("run-file.viewer", {
  grantedTo: [runFileViewers],
  grants: [can.view(Document), can.apply(extractDocument), can.run(inspectDocumentWorkflow)],
})

async function createRunFileApi(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
    id: "test-project",
    ontology: [Document],
    actions: [extractDocument],
    workflows: [inspectDocumentWorkflow],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage,
    queues: new InMemoryQueues(),
    groups: [runFileViewers],
    roles: [runFileViewerRole],
    auth: options.auth ? { id: "test", kind: "dev" } : undefined,
  })

  await sixb.upsertObject("document", { id: "doc-1" })

  const actionPdf = await blobStorage.put({
    body: new TextEncoder().encode("action pdf"),
    fileName: "action.pdf",
    mediaType: "application/pdf",
  })
  const workflowInput = await blobStorage.put({
    body: new TextEncoder().encode("workflow input"),
    fileName: "workflow-input.pdf",
    mediaType: "application/pdf",
  })
  const workflowOutput = await blobStorage.put({
    body: new TextEncoder().encode("workflow output"),
    fileName: "workflow-output.md",
    mediaType: "text/markdown",
  })

  await storage.actionRuns.queue({
    id: "action_run_1",
    projectId: sixb.id,
    actionId: extractDocument.id,
    subject: { kind: "object", objectTypeId: Document.id, primaryId: "doc-1" },
    params: {
      sourcePdf: fileRefJson(actionPdf),
      title: "not a file",
    },
    idempotencyKey: "action_run_1",
    queuedAt: new Date("2026-06-30T12:00:00.000Z"),
  })

  await storage.workflowRuns.start({
    id: "workflow_run_1",
    projectId: sixb.id,
    workflowId: inspectDocumentWorkflow.id,
    input: {
      document: fileRefJson(workflowInput),
      title: "not a file",
    },
    startedAt: new Date("2026-06-30T12:01:00.000Z"),
  })
  await storage.workflowRuns.nodes.start({
    id: "workflow_node_1",
    projectId: sixb.id,
    workflowRunId: "workflow_run_1",
    workflowId: inspectDocumentWorkflow.id,
    nodeIndex: 0,
    nodeType: "step",
    nodeId: inspectDocumentStep.id,
    nodeKey: "extract",
    input: {
      document: fileRefJson(workflowInput),
    },
    startedAt: new Date("2026-06-30T12:02:00.000Z"),
  })
  await storage.workflowRuns.nodes.finish({
    id: "workflow_node_1",
    projectId: sixb.id,
    status: "succeeded",
    output: {
      report: fileRefJson(workflowOutput),
      notes: "not a file",
    },
    finishedAt: new Date("2026-06-30T12:03:00.000Z"),
  })

  return {
    app: createSixbApi(new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })),
    storage,
  }
}

async function seedSession(storage: InMemoryStorage, groupIds: readonly string[]) {
  const credential = createSessionCredential(`ses_${groupIds.join("_") || "none"}`)
  await storage.auth.users.create({
    id: `usr_${groupIds.join("_") || "none"}`,
    projectId: "test-project",
    email: `${groupIds.join("-") || "none"}@example.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId: `usr_${groupIds.join("_") || "none"}`,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId: `usr_${groupIds.join("_") || "none"}`,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    expiresAt: new Date("2099-06-30T12:00:00.000Z"),
  })

  return { cookie: `sixb_session=${credential.cookieValue}` }
}

function fileRefJson(fileRef: FileRef): Record<string, string | number> {
  const value: Record<string, string | number> = {
    blobId: fileRef.blobId,
    digest: fileRef.digest,
    sizeBytes: fileRef.sizeBytes,
  }
  if (fileRef.fileName) {
    value.fileName = fileRef.fileName
  }
  if (fileRef.mediaType) {
    value.mediaType = fileRef.mediaType
  }
  if (fileRef.logicalPath) {
    value.logicalPath = fileRef.logicalPath
  }
  return value
}

function contentRequest(
  path: string,
  options: { readonly method?: string; readonly headers?: HeadersInit } = {}
) {
  return new Request(`http://localhost${path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
  })
}

describe("run file content routes", () => {
  test("streams action run FileRef content", async () => {
    const { app } = await createRunFileApi()

    const response = await app.fetch(
      contentRequest("/api/action-runs/action_run_1/files/content?path=/params/sourcePdf")
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("10")
    expect(response.headers.get("content-disposition")).toContain('inline; filename="action.pdf"')
    expect(await response.text()).toBe("action pdf")
  })

  test("streams workflow run and node FileRef content", async () => {
    const { app } = await createRunFileApi()

    const input = await app.fetch(
      contentRequest("/api/workflow-runs/workflow_run_1/files/content?path=/input/document")
    )
    expect(input.status).toBe(200)
    expect(input.headers.get("content-disposition")).toContain(
      'inline; filename="workflow-input.pdf"'
    )
    expect(await input.text()).toBe("workflow input")

    const output = await app.fetch(
      contentRequest(
        "/api/workflow-runs/workflow_run_1/nodes/extract/files/content?path=/output/report"
      )
    )
    expect(output.status).toBe(200)
    expect(output.headers.get("content-type")).toBe("text/markdown")
    expect(output.headers.get("content-disposition")).toContain(
      'inline; filename="workflow-output.md"'
    )
    expect(await output.text()).toBe("workflow output")
  })

  test("returns headers without a body for HEAD requests", async () => {
    const { app } = await createRunFileApi()

    const response = await app.fetch(
      contentRequest("/api/action-runs/action_run_1/files/content?path=/params/sourcePdf", {
        method: "HEAD",
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    expect(response.headers.get("content-length")).toBe("10")
    expect(await response.text()).toBe("")
  })

  test("hides missing runs, invalid paths, and non-file values as 404", async () => {
    const { app } = await createRunFileApi()

    for (const path of [
      "/api/action-runs/missing/files/content?path=/params/sourcePdf",
      "/api/action-runs/action_run_1/files/content?path=/params/missing",
      "/api/action-runs/action_run_1/files/content?path=/params/title",
      "/api/workflow-runs/workflow_run_1/nodes/missing/files/content?path=/output/report",
      "/api/workflow-runs/workflow_run_1/nodes/extract/files/content?path=/output/notes",
    ]) {
      const response = await app.fetch(contentRequest(path))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: "File not found" })
    }
  })

  test("rejects paths outside supported run fields", async () => {
    const { app } = await createRunFileApi()

    for (const path of [
      "/api/action-runs/action_run_1/files/content?path=/subject",
      "/api/workflow-runs/workflow_run_1/files/content?path=/workflowId",
      "/api/workflow-runs/workflow_run_1/nodes/extract/files/content?path=/status",
    ]) {
      const response = await app.fetch(contentRequest(path))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "Invalid file content query" })
    }
  })

  test("uses action and workflow run visibility authorization", async () => {
    const { app, storage } = await createRunFileApi({ auth: true })
    const allowed = await seedSession(storage, [runFileViewers.id])
    const denied = await seedSession(storage, [])

    const allowedAction = await app.fetch(
      contentRequest("/api/action-runs/action_run_1/files/content?path=/params/sourcePdf", {
        headers: allowed,
      })
    )
    expect(allowedAction.status).toBe(200)
    expect(await allowedAction.text()).toBe("action pdf")

    const deniedAction = await app.fetch(
      contentRequest("/api/action-runs/action_run_1/files/content?path=/params/sourcePdf", {
        headers: denied,
      })
    )
    expect(deniedAction.status).toBe(404)
    expect(await deniedAction.json()).toEqual({ error: "File not found" })

    const allowedWorkflow = await app.fetch(
      contentRequest("/api/workflow-runs/workflow_run_1/files/content?path=/input/document", {
        headers: allowed,
      })
    )
    expect(allowedWorkflow.status).toBe(200)
    expect(await allowedWorkflow.text()).toBe("workflow input")

    const deniedWorkflow = await app.fetch(
      contentRequest("/api/workflow-runs/workflow_run_1/files/content?path=/input/document", {
        headers: denied,
      })
    )
    expect(deniedWorkflow.status).toBe(404)
    expect(await deniedWorkflow.json()).toEqual({ error: "File not found" })
  })
})
