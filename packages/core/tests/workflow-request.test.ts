import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  Pario,
  type ParioRuntimeContext,
  prop,
  type Queues,
  ref,
  requestWorkflowRun,
  type Storage,
  type WorkflowDefinition,
  WorkflowValidationError,
} from "../src"
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

function createPario() {
  const workflows: readonly WorkflowDefinition[] = [draftInvoice, reviewTransaction]
  return new Pario({
    ontology: [Transaction, Invoice],
    workflows,
    ...createTestRuntimeDeps(),
  })
}

function validInput() {
  return { transaction: { objectTypeId: "Transaction" as const, primaryId: "txn_1" } }
}

async function claimAll(pario: { queues: Queues; id: string }) {
  return pario.queues.workflows.claim({ projectId: pario.id, workerId: "test", limit: 50 })
}

describe("pario.workflows.request", () => {
  test("queues a run, enqueues a job, and emits workflow.run.queued", async () => {
    const pario = createPario()

    const result = await pario.workflows.request(draftInvoice, { input: validInput() })

    expect(result.created).toBe(true)
    expect(result.workflowId).toBe("draft-invoice")
    expect(result.runId).toMatch(/^run_/)
    expect(result.jobId).toBeDefined()

    const run = await pario.storage.workflowRuns?.getById({ projectId: pario.id, id: result.runId })
    expect(run?.status).toBe("queued")
    expect(run?.workflowId).toBe("draft-invoice")
    expect(run?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const jobs = await claimAll(pario)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.job.payload).toMatchObject({
      workflowId: "draft-invoice",
      runId: result.runId,
      input: { transaction: { objectTypeId: "Transaction", primaryId: "txn_1" } },
    })

    const events = await pario.events.read({ types: ["workflow.run.queued"] })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      workflowId: "draft-invoice",
      runId: result.runId,
      queuedAt: result.queuedAt,
      jobId: result.jobId,
    })
  })

  test("requestById rejects unknown input fields at runtime", async () => {
    const pario = createPario()

    await expect(
      pario.workflows.requestById({ workflowId: "draft-invoice", input: { bogus: true } })
    ).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  test("rejects invalid input before any storage or queue write", async () => {
    const pario = createPario()

    await expect(
      pario.workflows.requestById({ workflowId: "draft-invoice", runId: "run_fixed", input: {} })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await pario.storage.workflowRuns?.getById({ projectId: pario.id, id: "run_fixed" })
    expect(run).toBeNull()
    expect(await claimAll(pario)).toHaveLength(0)
    expect(await pario.events.read({ types: ["workflow.run.queued"] })).toHaveLength(0)
  })

  test("throws for an unknown workflow", async () => {
    const pario = createPario()

    await expect(pario.workflows.requestById({ workflowId: "missing", input: {} })).rejects.toThrow(
      "[Pario] Unknown workflow 'missing'"
    )
  })

  test("deterministic runId returns the existing run without enqueuing twice", async () => {
    const pario = createPario()

    const first = await pario.workflows.request(draftInvoice, {
      runId: "run_dedupe",
      input: validInput(),
    })
    const second = await pario.workflows.request(draftInvoice, {
      runId: "run_dedupe",
      input: validInput(),
    })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.runId).toBe("run_dedupe")
    expect(second.queuedAt).toBe(first.queuedAt)
    expect(second.jobId).toBeUndefined()

    expect(await claimAll(pario)).toHaveLength(1)
    expect(await pario.events.read({ types: ["workflow.run.queued"] })).toHaveLength(1)
  })

  test("deterministic runId throws when reused for a different workflow", async () => {
    const pario = createPario()

    await pario.workflows.request(draftInvoice, { runId: "run_shared", input: validInput() })

    await expect(
      pario.workflows.requestById({
        workflowId: "review-transaction",
        runId: "run_shared",
        input: validInput(),
      })
    ).rejects.toThrow("already exists for a different workflow")
  })

  test("persists and emits the run source", async () => {
    const pario = createPario()
    const source = {
      type: "webhook" as const,
      connectorId: "companycam",
      webhookId: "photo-created",
      deliveryId: "delivery-1",
    }

    const result = await pario.workflows.request(draftInvoice, { input: validInput(), source })

    const run = await pario.storage.workflowRuns?.getById({ projectId: pario.id, id: result.runId })
    expect(run?.source).toEqual(source)

    const events = await pario.events.read({ types: ["workflow.run.queued"] })
    expect(events[0]?.payload).toMatchObject({ source })
  })

  test("retried webhook delivery with a deterministic runId enqueues a single run", async () => {
    const pario = createPario()
    const source = {
      type: "webhook" as const,
      connectorId: "companycam",
      webhookId: "photo-created",
      deliveryId: "delivery-1",
    }
    const options = { runId: "run_companycam_photo-1", input: validInput(), source }

    const first = await pario.workflows.request(draftInvoice, options)
    const second = await pario.workflows.request(draftInvoice, options)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(await claimAll(pario)).toHaveLength(1)
  })

  test("throws a clear error when workflow run storage is not configured", async () => {
    const pario = createPario()
    const runtime: ParioRuntimeContext = {
      projectId: pario.id,
      ontology: pario.ontology,
      actionRegistry: pario.actionRegistry,
      events: pario.events,
      storage: { ...pario.storage, workflowRuns: undefined } as Storage,
      lakeStorage: pario.lakeStorage,
      blobStorage: pario.blobStorage,
      queues: pario.queues,
    }

    await expect(
      requestWorkflowRun(runtime, draftInvoice, { input: validInput() })
    ).rejects.toThrow("[Pario] Workflow run storage is not configured.")
  })

  test("throws a clear error when the workflow queue is not configured", async () => {
    const pario = createPario()
    const runtime: ParioRuntimeContext = {
      projectId: pario.id,
      ontology: pario.ontology,
      actionRegistry: pario.actionRegistry,
      events: pario.events,
      storage: pario.storage,
      lakeStorage: pario.lakeStorage,
      blobStorage: pario.blobStorage,
      queues: { ...pario.queues, workflows: undefined } as unknown as Queues,
    }

    await expect(
      requestWorkflowRun(runtime, draftInvoice, { input: validInput() })
    ).rejects.toThrow("[Pario] Workflow run queue is not configured.")
  })
})
