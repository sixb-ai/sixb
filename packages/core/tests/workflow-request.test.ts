import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  prop,
  type Queues,
  ref,
  SixbHost,
  type WorkflowDefinition,
  WorkflowValidationError,
} from "../src"
import { flushSixbErrors } from "../src/error-reporting/internal"
import { WorkflowRunError } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { WorkflowRunDispatcher } from "../src/workflows/run-dispatch"
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
  const host = new SixbHost({
    ontology: [Transaction, Invoice],
    workflows,
    ...createTestRuntimeDeps(),
  })
  return { host, sixb: createTestSixb(host) }
}

function validInput() {
  return { transaction: { objectTypeId: "Transaction" as const, primaryId: "txn_1" } }
}

async function claimAll(host: { queues: Queues; id: string }) {
  return host.queues.workflows.claim({ projectId: host.id, workerId: "test", limit: 50 })
}

describe("sixb.workflows.request", () => {
  test("queues a run, enqueues a job, and emits workflow.run.queued", async () => {
    const { host, sixb } = createSixb()

    const result = await sixb.workflows.request(draftInvoice, { input: validInput() })

    expect(result.created).toBe(true)
    expect(result.workflowId).toBe("draft-invoice")
    expect(result.runId).toMatch(/^run_/)
    expect(result.jobId).toBeDefined()

    const run = await host.storage.workflowRuns?.getById({
      projectId: sixb.execution.projectId,
      id: result.runId,
    })
    expect(run?.status).toBe("queued")
    expect(run?.workflowId).toBe("draft-invoice")
    expect(run?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })
    const execution = run
      ? await host.storage.executions.getById({
          projectId: sixb.execution.projectId,
          id: run.executionId,
        })
      : null
    expect(execution).toMatchObject({
      executor: { type: "primitive", kind: "workflow", runId: result.runId },
      source: { type: "execution", executionId: sixb.execution.id },
      parentExecutionId: sixb.execution.id,
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "workflow", id: "draft-invoice", runId: result.runId },
      },
    })

    const jobs = await claimAll(host)
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
    const host = new SixbHost({
      id: "workflow-enqueue-failure",
      ontology: [Transaction, Invoice],
      workflows: [draftInvoice],
      onError(error, context) {
        reports.push(`${context.notificationId}:${error.message}`)
      },
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)

    await expect(
      sixb.workflows.request(draftInvoice, {
        runId: "run_enqueue_failure",
        input: validInput(),
      })
    ).rejects.toThrow("workflow queue unavailable")

    const run = await host.storage.workflowRuns?.getById({
      projectId: sixb.execution.projectId,
      id: "run_enqueue_failure",
    })
    expect(run).toMatchObject({ status: "failed", error: "workflow queue unavailable" })
    await flushSixbErrors(host)
    expect(reports).toEqual([
      `project:workflow-enqueue-failure:run:workflow:run_enqueue_failure:failed:${run?.finishedAt?.toISOString()}:workflow queue unavailable`,
    ])
  })

  test("rolls back the workflow execution when run persistence fails", async () => {
    const { host, sixb } = createSixb()
    const executions = host.storage.executions
    const workflowRuns = host.storage.workflowRuns!
    const transaction = host.storage.transaction.bind(host.storage)
    let childExecutionId: string | undefined
    host.storage.transaction = (run, options) => {
      return transaction(async (tx) => {
        await run(tx)
        const queued = await tx.workflowRuns?.getById({
          projectId: sixb.execution.projectId,
          id: "run_storage_failure",
        })
        childExecutionId = queued?.executionId
        throw new WorkflowRunError("workflow storage unavailable")
      }, options)
    }

    await expect(
      sixb.workflows.request(draftInvoice, {
        runId: "run_storage_failure",
        input: validInput(),
      })
    ).rejects.toThrow("workflow storage unavailable")

    expect(childExecutionId).toBeDefined()
    expect(
      await executions.getById({ projectId: sixb.execution.projectId, id: sixb.execution.id })
    ).not.toBeNull()
    expect(
      childExecutionId
        ? await executions.getById({
            projectId: sixb.execution.projectId,
            id: childExecutionId,
          })
        : null
    ).toBeNull()
    expect(
      await workflowRuns.getById({
        projectId: sixb.execution.projectId,
        id: "run_storage_failure",
      })
    ).toBeNull()
  })

  test("requestById rejects unknown input fields at runtime", async () => {
    const { sixb } = createSixb()

    await expect(
      sixb.workflows.requestById({ workflowId: "draft-invoice", input: { bogus: true } })
    ).rejects.toBeInstanceOf(WorkflowValidationError)
  })

  test("rejects invalid input before any storage or queue write", async () => {
    const { host, sixb } = createSixb()

    await expect(
      sixb.workflows.requestById({ workflowId: "draft-invoice", runId: "run_fixed", input: {} })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await host.storage.workflowRuns?.getById({
      projectId: sixb.execution.projectId,
      id: "run_fixed",
    })
    expect(run).toBeNull()
    expect(await claimAll(host)).toHaveLength(0)
    expect(await sixb.events.read({ types: ["workflow.run.queued"] })).toHaveLength(0)
  })

  test("throws for an unknown workflow", async () => {
    const { sixb } = createSixb()

    await expect(sixb.workflows.requestById({ workflowId: "missing", input: {} })).rejects.toThrow(
      "[Sixb] Unknown workflow 'missing'"
    )
  })

  test("deterministic runId returns the existing run without enqueuing twice", async () => {
    const { host, sixb } = createSixb()

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

    expect(await claimAll(host)).toHaveLength(1)
    expect(await sixb.events.read({ types: ["workflow.run.queued"] })).toHaveLength(1)
  })

  test("deterministic runId throws when reused for a different workflow", async () => {
    const { sixb } = createSixb()

    await sixb.workflows.request(draftInvoice, { runId: "run_shared", input: validInput() })

    await expect(
      sixb.workflows.requestById({
        workflowId: "review-transaction",
        runId: "run_shared",
        input: validInput(),
      })
    ).rejects.toThrow("already exists with a different request payload")
  })

  test("emits the request source without duplicating it on the run", async () => {
    const { sixb } = createSixb()
    const source = {
      type: "webhook" as const,
      connectorId: "companycam",
      webhookId: "photo-created",
      deliveryId: "delivery-1",
    }

    await sixb.workflows.request(draftInvoice, { input: validInput(), source })

    const events = await sixb.events.read({ types: ["workflow.run.queued"] })
    expect(events[0]?.payload).toMatchObject({ source })
  })

  test("retried webhook delivery with a deterministic runId enqueues a single run", async () => {
    const { host, sixb } = createSixb()
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
    expect(await claimAll(host)).toHaveLength(1)
  })

  test("throws a clear error when workflow run storage is not configured", async () => {
    const runtimeDeps = createTestRuntimeDeps()
    Object.defineProperty(runtimeDeps.storage, "workflowRuns", { value: undefined })
    const host = new SixbHost({
      ontology: [Transaction, Invoice],
      workflows: [draftInvoice],
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)

    await expect(sixb.workflows.request(draftInvoice, { input: validInput() })).rejects.toThrow(
      "[Sixb] Workflow run storage is not configured."
    )
  })
})

describe("automatic workflow dispatch", () => {
  test("persists an honest root execution before publishing the queue job", async () => {
    const { host } = createSixb()
    const dispatcher = new WorkflowRunDispatcher(host)

    const result = await dispatcher.dispatch({
      workflowId: draftInvoice.id,
      runId: "workflow:draft-invoice:schedule:daily:event:event-1",
      input: validInput(),
      scheduleId: "daily",
      source: { type: "schedule", eventId: "event-1" },
      correlationId: "correlation-1",
      metadata: { sourceEventId: "event-1" },
    })

    const run = await host.storage.workflowRuns?.getById({
      projectId: host.id,
      id: result.runId,
    })
    const execution = run
      ? await host.storage.executions.getById({ projectId: host.id, id: run.executionId })
      : null
    expect(execution).toMatchObject({
      projectId: host.id,
      executor: { type: "primitive", kind: "workflow", runId: result.runId },
      source: { type: "schedule", eventId: "event-1" },
      correlationId: "correlation-1",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: { kind: "workflow", id: draftInvoice.id, runId: result.runId },
      },
    })
    expect(execution?.parentExecutionId).toBeUndefined()
    expect(execution?.requestedBy).toBeUndefined()

    const [claimed] = await claimAll(host)
    expect(claimed?.job).toMatchObject({
      id: result.runId,
      payload: { workflowId: draftInvoice.id, runId: result.runId, input: validInput() },
      metadata: { sourceEventId: "event-1" },
    })
    const [queuedEvent] = await host.events.read({ types: ["workflow.run.queued"] })
    expect(
      queuedEvent && "correlationId" in queuedEvent ? queuedEvent.correlationId : undefined
    ).toBe("correlation-1")
  })

  test("uses event provenance for event-based schedules and deduplicates replay", async () => {
    const { host } = createSixb()
    const dispatcher = new WorkflowRunDispatcher(host)
    const input = {
      workflowId: draftInvoice.id,
      runId: "workflow:draft-invoice:schedule:on-update:event:event-2",
      input: validInput(),
      scheduleId: "on-update",
      source: { type: "event" as const, eventId: "event-2" },
      correlationId: "upstream-correlation",
    }

    const first = await dispatcher.dispatch(input)
    const second = await dispatcher.dispatch(input)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    const run = await host.storage.workflowRuns?.getById({ projectId: host.id, id: input.runId })
    const execution = run
      ? await host.storage.executions.getById({ projectId: host.id, id: run.executionId })
      : null
    expect(execution).toMatchObject({
      source: { type: "event", eventId: "event-2" },
      correlationId: "upstream-correlation",
    })
    expect(await claimAll(host)).toHaveLength(1)
    await expect(
      dispatcher.dispatch({ ...input, correlationId: "different-correlation" })
    ).rejects.toThrow("already exists with different automatic provenance")
  })
})
