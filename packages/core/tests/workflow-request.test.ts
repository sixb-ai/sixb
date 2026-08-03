import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  prop,
  type Queues,
  ref,
  requestWorkflowRun,
  Sixb,
  type SixbRuntimeContext,
  type Storage,
  type WorkflowDefinition,
} from "../src"
import { flushSixbErrors } from "../src/error-reporting/internal"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const findBestInvoice = defineWorkflowStep("find-best-invoice")
  .input({ transaction: ref(Transaction) })
  .output({ invoice: ref(Invoice) })
  .run(async () => ({ invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" } }))

const draftInvoice = defineWorkflow("draft-invoice")
  .input({ transaction: ref(Transaction) })
  .then(findBestInvoice)

// Widened to the base type: only used for registration and id lookup, so it
// keeps the registered workflow array from instantiating two deep chain types.
const reviewTransaction: WorkflowDefinition = defineWorkflow("review-transaction")
  .input({ transaction: ref(Transaction) })
  .then(findBestInvoice)

function createSixb() {
  const workflows: readonly WorkflowDefinition[] = [draftInvoice, reviewTransaction]
  return new Sixb({
    ontology: [Transaction, Invoice],
    workflows,
    ...createTestRuntimeDeps(),
  })
}

function validInput() {
  return { transaction: { objectTypeId: "Transaction" as const, primaryId: "txn_1" } }
}

async function claimAll(sixb: { queues: Queues; id: string }) {
  return sixb.queues.workflows.claim({ projectId: sixb.id, workerId: "test", limit: 50 })
}

describe("sixb.workflows.request", () => {
  test("queues a run, enqueues a job, and emits workflow.run.queued", async () => {
    const sixb = createSixb()

    const result = await sixb.workflows.request(draftInvoice, { input: validInput() })

    expect(result.created).toBe(true)
    expect(result.workflowId).toBe("draft-invoice")
    expect(result.runId).toMatch(/^run_/)
    expect(result.jobId).toBeDefined()

    const run = await sixb.storage.workflowRuns?.getById({ projectId: sixb.id, id: result.runId })
    expect(run?.status).toBe("queued")
    expect(run?.workflowId).toBe("draft-invoice")
    expect(run?.requestedByPrincipal).toEqual({ type: "system", id: "system" })
    expect(run?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const jobs = await claimAll(sixb)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.job.payload).toMatchObject({
      workflowId: "draft-invoice",
      runId: result.runId,
      input: { transaction: { objectTypeId: "Transaction", primaryId: "txn_1" } },
    })

    const events = await sixb.events.read({ types: ["workflow.run.queued"] })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      workflowId: "draft-invoice",
      runId: result.runId,
      queuedAt: result.queuedAt,
      jobId: result.jobId,
    })
  })

  test("marks and reports a run failed when queue dispatch fails", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    runtimeDeps.queues.workflows.enqueue = async () => {
      throw new Error("workflow queue unavailable")
    }
    const reports: string[] = []
    const sixb = new Sixb({
      id: "workflow-enqueue-failure",
      ontology: [Transaction, Invoice],
      workflows: [draftInvoice],
      onError(failure, context) {
        reports.push(`${context.notificationId}:${failure.message}`)
      },
      ...runtimeDeps,
    })

    await expect(
      sixb.workflows.request(draftInvoice, {
        runId: "run_enqueue_failure",
        input: validInput(),
      })
    ).rejects.toThrow("workflow queue unavailable")

    const run = await sixb.storage.workflowRuns?.getById({
      projectId: sixb.id,
      id: "run_enqueue_failure",
    })
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "workflow.failed", message: "workflow queue unavailable" },
    })
    await flushSixbErrors(sixb)
    expect(reports).toEqual([
      `project:workflow-enqueue-failure:run:workflow:run_enqueue_failure:failed:${run?.finishedAt?.toISOString()}:workflow queue unavailable`,
    ])
  })

  test("requestById rejects unknown input fields at runtime", async () => {
    const sixb = createSixb()

    await expect(
      sixb.workflows.requestById({ workflowId: "draft-invoice", input: { bogus: true } })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")
  })

  test("rejects invalid input before any storage or queue write", async () => {
    const sixb = createSixb()

    await expect(
      sixb.workflows.requestById({ workflowId: "draft-invoice", runId: "run_fixed", input: {} })
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

    const run = await sixb.storage.workflowRuns?.getById({ projectId: sixb.id, id: "run_fixed" })
    expect(run).toBeNull()
    expect(await claimAll(sixb)).toHaveLength(0)
    expect(await sixb.events.read({ types: ["workflow.run.queued"] })).toHaveLength(0)
  })

  test("throws for an unknown workflow", async () => {
    const sixb = createSixb()

    // The code and not just the message: `workflow.not_found` is what the HTTP route answers for the
    // same condition, and this door used to say `runtime.invalid_input` instead — a 400 for
    // something that is a 404.
    await expect(
      sixb.workflows.requestById({ workflowId: "missing", input: {} })
    ).rejects.toHaveProperty("code", "workflow.not_found")
    await expect(sixb.workflows.requestById({ workflowId: "missing", input: {} })).rejects.toThrow(
      "[Sixb] Unknown workflow 'missing'"
    )
  })

  test("deterministic runId returns the existing run without enqueuing twice", async () => {
    const sixb = createSixb()

    const first = await sixb.workflows.request(draftInvoice, {
      runId: "run_dedupe",
      input: validInput(),
    })
    const second = await sixb.workflows.request(draftInvoice, {
      runId: "run_dedupe",
      input: validInput(),
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.runId).toBe("run_dedupe")
    expect(second.queuedAt).toBe(first.queuedAt)
    expect(second.jobId).toBeUndefined()

    expect(await claimAll(sixb)).toHaveLength(1)
    expect(await sixb.events.read({ types: ["workflow.run.queued"] })).toHaveLength(1)
  })

  test("deterministic runId throws when reused for a different workflow", async () => {
    const sixb = createSixb()

    await sixb.workflows.request(draftInvoice, { runId: "run_shared", input: validInput() })

    await expect(
      sixb.workflows.requestById({
        workflowId: "review-transaction",
        runId: "run_shared",
        input: validInput(),
      })
    ).rejects.toThrow("already exists for a different workflow")
  })

  test("persists and emits the run source", async () => {
    const sixb = createSixb()
    const source = {
      type: "webhook" as const,
      connectorId: "companycam",
      webhookId: "photo-created",
      deliveryId: "delivery-1",
    }

    const result = await sixb.workflows.request(draftInvoice, { input: validInput(), source })

    const run = await sixb.storage.workflowRuns?.getById({ projectId: sixb.id, id: result.runId })
    expect(run?.source).toEqual(source)

    const events = await sixb.events.read({ types: ["workflow.run.queued"] })
    expect(events[0]?.payload).toMatchObject({ source })
  })

  test("retried webhook delivery with a deterministic runId enqueues a single run", async () => {
    const sixb = createSixb()
    const source = {
      type: "webhook" as const,
      connectorId: "companycam",
      webhookId: "photo-created",
      deliveryId: "delivery-1",
    }
    const options = { runId: "run_companycam_photo-1", input: validInput(), source }

    const first = await sixb.workflows.request(draftInvoice, options)
    const second = await sixb.workflows.request(draftInvoice, options)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(await claimAll(sixb)).toHaveLength(1)
  })

  test("throws a clear error when workflow run storage is not configured", async () => {
    const sixb = createSixb()
    const runtime: SixbRuntimeContext = {
      projectId: sixb.id,
      ontology: sixb.ontology,
      actionRegistry: sixb.actionRegistry,
      events: sixb.events,
      storage: { ...sixb.storage, workflowRuns: undefined } as Storage,
      lakeStorage: sixb.lakeStorage,
      blobStorage: sixb.blobStorage,
      queues: sixb.queues,
    }

    await expect(
      requestWorkflowRun(runtime, draftInvoice, { input: validInput() })
    ).rejects.toThrow("[Sixb] Workflow run storage is not configured.")
  })

  test("throws a clear error when the workflow queue is not configured", async () => {
    const sixb = createSixb()
    const runtime: SixbRuntimeContext = {
      projectId: sixb.id,
      ontology: sixb.ontology,
      actionRegistry: sixb.actionRegistry,
      events: sixb.events,
      storage: sixb.storage,
      lakeStorage: sixb.lakeStorage,
      blobStorage: sixb.blobStorage,
      queues: { ...sixb.queues, workflows: undefined } as unknown as Queues,
    }

    await expect(
      requestWorkflowRun(runtime, draftInvoice, { input: validInput() })
    ).rejects.toThrow("[Sixb] Workflow run queue is not configured.")
  })
})
