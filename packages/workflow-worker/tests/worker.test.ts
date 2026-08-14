import { afterEach, describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  defineIntervention,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  ref,
  type SixbErrorContext,
  type SixbErrorHandler,
  SixbHost,
  type WorkflowDefinition,
} from "@sixb/core"
import { LOGS_STREAM } from "@sixb/core/internal/logging"
import {
  createTestSixb,
  createTestWorkflowExecution,
  type TestExecutionHost,
} from "@sixb/core/testing"
import { WorkflowWorker } from "../src"

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
  .input({
    transaction: ref(Transaction),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(() => ({
    invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
  }))

const slowStep = defineWorkflowStep("slow-step")
  .input({})
  .output({})
  .run(async () => {
    await Bun.sleep(50)
    return {}
  })

const workflowExplosion = new Error("workflow exploded")
const failingStep = defineWorkflowStep("explode")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(() => {
    throw workflowExplosion
  })

const reviewInvoice = defineIntervention("review-invoice")
  .input({
    invoice: ref(Invoice),
  })
  .response({
    approvedInvoice: ref(Invoice),
  })

const finalizeInvoice = defineWorkflowStep("finalize-invoice")
  .input({
    approvedInvoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(({ input }) => ({
    invoice: input.approvedInvoice,
  }))

const workers: WorkflowWorker[] = []

afterEach(async () => {
  for (const worker of workers) {
    await worker.stop().catch(() => {})
  }
  workers.length = 0
})

function createSixb(options: {
  readonly workflows?: readonly WorkflowDefinition[]
  readonly actions?: readonly ActionDefinition[]
  readonly onError?: SixbErrorHandler
}) {
  return new SixbHost({
    id: "workflow-worker-tests",
    ontology: [Transaction, Invoice],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    onError: options.onError,
    actions: options.actions ?? [],
    workflows: options.workflows ?? [],
  })
}

async function requestWorkflowRun(
  sixb: TestExecutionHost,
  workflow: WorkflowDefinition,
  runId: string,
  input: Readonly<Record<string, unknown>>
): Promise<void> {
  await createTestSixb(sixb).workflows.requestById({ workflowId: workflow.id, runId, input })
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }

    await Bun.sleep(20)
  }

  throw new Error("Timed out waiting for condition.")
}

describe("WorkflowWorker", () => {
  test("requires registered workflows and workflow storage", () => {
    expect(() => new WorkflowWorker(createSixb({}))).toThrow("No workflow definitions")

    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })
    const storageWithoutWorkflowRuns = { ...sixb.storage, workflowRuns: undefined }
    const withoutWorkflowRuns = new Proxy(sixb, {
      get(target, property, receiver) {
        return property === "storage"
          ? storageWithoutWorkflowRuns
          : Reflect.get(target, property, receiver)
      },
    })

    expect(() => new WorkflowWorker(withoutWorkflowRuns)).toThrow("storage.workflowRuns")

    const interventionWorkflow = defineWorkflow("review-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoice)
    const sixbWithIntervention = createSixb({ workflows: [interventionWorkflow] })
    const storageWithoutInterventions = {
      ...sixbWithIntervention.storage,
      workflowInterventions: undefined,
    }
    const withoutWorkflowInterventions = new Proxy(sixbWithIntervention, {
      get(target, property, receiver) {
        return property === "storage"
          ? storageWithoutInterventions
          : Reflect.get(target, property, receiver)
      },
    })

    expect(() => new WorkflowWorker(withoutWorkflowInterventions)).toThrow(
      "storage.workflowInterventions"
    )
  })

  test("streams a run-scoped log line to the broker", async () => {
    const loggedStep = defineWorkflowStep("log-step")
      .input({ transaction: ref(Transaction) })
      .output({ invoice: ref(Invoice) })
      .run(({ input, logger }) => {
        logger.info("Reviewing transaction", { txn: input.transaction.primaryId })
        return { invoice: { objectTypeId: "Invoice", primaryId: "inv_1" } }
      })
    const workflow = defineWorkflow("logged-workflow")
      .input({ transaction: ref(Transaction) })
      .then(loggedStep)
    const sixb = createSixb({ workflows: [workflow] })
    await requestWorkflowRun(sixb, workflow, "wfrun_log", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () => sixb.storage.workflowRuns!.getById({ projectId: sixb.id, id: "wfrun_log" }),
      (value) => value?.status === "succeeded"
    )

    const { records } = await sixb.broker.read({
      projectId: sixb.id,
      streamId: LOGS_STREAM.id,
      names: ["workflow.info"],
    })
    const line = records.find(
      (record) => (record.payload as { message?: string }).message === "Reviewing transaction"
    )
    expect(line?.key).toBe("workflow:wfrun_log")
    const payload = line?.payload as {
      level: string
      fields?: { txn?: string }
      context?: { run?: { kind?: string; id?: string }; stepId?: string }
    }
    expect(payload.level).toBe("info")
    expect(payload.fields?.txn).toBe("txn_1")
    expect(payload.context?.stepId).toBe("log-step")
    expect(payload.context?.run).toEqual({ kind: "workflow", id: "wfrun_log" })
  })

  test("processes queued workflow jobs and emits workflow lifecycle events", async () => {
    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })
    await requestWorkflowRun(sixb, workflow, "wfrun_worker_success", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_success",
        }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.workflowId).toBe(workflow.id)

    const events = await waitFor(
      () =>
        sixb.events.read({
          types: [
            "workflow.run.started",
            "workflow.run.node.started",
            "workflow.run.node.finished",
            "workflow.run.finished",
          ],
        }),
      (value) => value.length === 4
    )
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.finished",
    ])
    expect(events[1]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_success",
      nodeRunId: "wfrun_worker_success:node:0",
      nodeIndex: 0,
      totalNodes: 1,
      nodeType: "step",
      nodeId: "find-best-invoice",
      nodeKey: "findBestInvoice",
    })
    expect(events[2]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_success",
      nodeRunId: "wfrun_worker_success:node:0",
      status: "succeeded",
    })
    expect(events[3]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_success",
      status: "succeeded",
      finishedAt: expect.any(String),
    })

    const claimed = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("loads workflow input from the persisted run referenced by the queue job", async () => {
    const echoTransaction = defineWorkflowStep("echo-transaction")
      .input({ transaction: ref(Transaction) })
      .output({ transaction: ref(Transaction) })
      .run(({ input }) => input)
    const workflow = defineWorkflow("persisted-workflow-input")
      .input({ transaction: ref(Transaction) })
      .then(echoTransaction)
    const sixb = createSixb({ workflows: [workflow] })
    const runId = "wfrun_persisted_input"
    await requestWorkflowRun(sixb, workflow, runId, {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_persisted" },
    })

    const [original] = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "discard-original",
    })
    if (!original) throw new Error("Expected the original workflow delivery.")
    await sixb.queues.workflows.complete({
      projectId: sixb.id,
      jobId: original.job.id,
      leaseId: original.leaseId,
    })
    await sixb.queues.workflows.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: { runId },
        },
      ],
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () => sixb.storage.workflowRuns!.getById({ projectId: sixb.id, id: runId }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.output).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_persisted" },
    })
  })

  test("reports a terminal failed workflow once with the original error", async () => {
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const workflow = defineWorkflow("failing-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(failingStep)
    const sixb = createSixb({
      workflows: [workflow],
      onError: (error, context) => {
        reports.push({ error, context })
      },
    })
    await requestWorkflowRun(sixb, workflow, "wfrun_worker_failed", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })
    await sixb.queues.workflows.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: { runId: "wfrun_worker_failed" },
        },
      ],
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_failed",
        }),
      (value) => value?.status === "failed"
    )
    expect(run?.error).toBe("workflow exploded")

    const reported = await waitFor(
      async () => reports,
      (value) => value.length === 1
    )
    expect(reported[0]?.error).toBe(workflowExplosion)
    expect(reported[0]?.context).toMatchObject({
      type: "run.failed",
      notificationId: `project:${sixb.id}:run:workflow:wfrun_worker_failed:failed:${run?.finishedAt?.toISOString()}`,
      projectId: sixb.id,
      attempt: 1,
      run: {
        kind: "workflow",
        runId: "wfrun_worker_failed",
        workflowId: workflow.id,
      },
    })
    expect(reported[0]?.context.occurredAt).toBe(run?.finishedAt?.toISOString() ?? "")

    const events = await waitFor(
      () =>
        sixb.events.read({
          types: [
            "workflow.run.started",
            "workflow.run.node.started",
            "workflow.run.node.finished",
            "workflow.run.finished",
          ],
        }),
      (value) => value.length === 4
    )
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.finished",
    ])
    expect(events[2]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_failed",
      nodeRunId: "wfrun_worker_failed:node:0",
      status: "failed",
      error: "workflow exploded",
    })
    expect(events[3]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_failed",
      status: "failed",
      finishedAt: expect.any(String),
      error: "workflow exploded",
    })

    await Bun.sleep(50)
    expect(reports).toHaveLength(1)

    const claimed = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("reports a queued run that fails before workflow start", async () => {
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const workflow = defineWorkflow("queued-invalid-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({
      workflows: [workflow],
      onError: (error, context) => {
        reports.push({ error, context })
      },
    })

    const executionId = await createTestWorkflowExecution(sixb.storage.executions, {
      projectId: sixb.id,
      workflowId: workflow.id,
      runId: "wfrun_queued_invalid",
    })
    await sixb.storage.workflowRuns!.queue({
      projectId: sixb.id,
      id: "wfrun_queued_invalid",
      executionId,
      workflowId: workflow.id,
      input: {},
    })
    await sixb.queues.workflows.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: { runId: "wfrun_queued_invalid" },
        },
      ],
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_queued_invalid",
        }),
      (value) => value?.status === "failed"
    )
    const reported = await waitFor(
      async () => reports,
      (value) => value.length === 1
    )

    expect(reported[0]?.error.message).toContain("Missing required field")
    expect(reported[0]?.context).toMatchObject({
      type: "run.failed",
      notificationId: `project:${sixb.id}:run:workflow:wfrun_queued_invalid:failed:${run?.finishedAt?.toISOString()}`,
      attempt: 1,
      run: {
        kind: "workflow",
        runId: "wfrun_queued_invalid",
        workflowId: workflow.id,
      },
    })
    expect(reported[0]?.context.occurredAt).toBe(run?.finishedAt?.toISOString() ?? "")
  })

  test("completes queue jobs when workflow runs suspend at intervention nodes", async () => {
    const workflow = defineWorkflow("review-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoice, ({ steps }) => ({
        invoice: steps.findBestInvoice.invoice,
      }))
    const sixb = createSixb({ workflows: [workflow] })
    await requestWorkflowRun(sixb, workflow, "wfrun_worker_waiting", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_waiting",
        }),
      (value) => value?.status === "waiting"
    )
    const interventions = await waitFor(
      () =>
        sixb.storage.workflowInterventions!.list({
          projectId: sixb.id,
          workflowRunId: "wfrun_worker_waiting",
        }),
      (value) => value.total === 1
    )
    const events = await waitFor(
      () =>
        sixb.events.read({
          types: [
            "workflow.run.started",
            "workflow.run.node.started",
            "workflow.run.node.finished",
            "workflow.intervention.requested",
            "workflow.run.node.waiting",
            "workflow.run.waiting",
          ],
        }),
      (value) => value.length === 7
    )

    expect(run?.workflowId).toBe(workflow.id)
    expect(interventions.interventions[0]).toMatchObject({
      id: "wfrun_worker_waiting:intervention:1",
      workflowRunId: "wfrun_worker_waiting",
      status: "pending",
      input: {
        invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
      },
    })
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.node.started",
      "workflow.intervention.requested",
      "workflow.run.node.waiting",
      "workflow.run.waiting",
    ])

    const claimed = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("processes resume jobs for submitted workflow interventions", async () => {
    const workflow = defineWorkflow("resume-reviewed-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoice, ({ steps }) => ({
        invoice: steps.findBestInvoice.invoice,
      }))
      .then(finalizeInvoice, ({ steps }) => ({
        approvedInvoice: steps.reviewInvoice.approvedInvoice,
      }))
    const sixb = createSixb({ workflows: [workflow] })

    await requestWorkflowRun(sixb, workflow, "wfrun_worker_resume", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_resume",
        }),
      (value) => value?.status === "waiting"
    )

    await sixb.storage.workflowInterventions!.submit({
      projectId: sixb.id,
      id: "wfrun_worker_resume:intervention:1",
      response: {
        approvedInvoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
      },
    })
    await sixb.queues.workflows.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "workflow.run.resume.requested",
          payload: {
            runId: "wfrun_worker_resume",
            resume: {
              kind: "intervention",
              interventionId: "wfrun_worker_resume:intervention:1",
            },
          },
        },
      ],
    })

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_resume",
        }),
      (value) => value?.status === "succeeded"
    )
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_worker_resume",
      order: "asc",
    })
    const events = await waitFor(
      () =>
        sixb.events.read({
          types: [
            "workflow.run.node.finished",
            "workflow.run.node.started",
            "workflow.run.finished",
          ],
        }),
      (value) => value.length === 7
    )

    expect(run?.workflowId).toBe(workflow.id)
    expect(nodes.nodes.map((node) => `${node.nodeId}:${node.status}`)).toEqual([
      "find-best-invoice:succeeded",
      "review-invoice:succeeded",
      "finalize-invoice:succeeded",
    ])
    expect(nodes.nodes[2]?.output).toEqual({
      invoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
    })
    expect(events.at(-1)?.type).toBe("workflow.run.finished")

    const claimed = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("reports a resumed workflow only when it transitions to failed", async () => {
    const resumeError = new Error("resumed workflow exploded")
    const failAfterResume = defineWorkflowStep("fail-after-resume")
      .input({ approvedInvoice: ref(Invoice) })
      .output({ invoice: ref(Invoice) })
      .run(() => {
        throw resumeError
      })
    const workflow = defineWorkflow("failing-resumed-workflow")
      .input({ transaction: ref(Transaction) })
      .then(findBestInvoice)
      .then(reviewInvoice, ({ steps }) => ({
        invoice: steps.findBestInvoice.invoice,
      }))
      .then(failAfterResume)
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const sixb = createSixb({
      workflows: [workflow],
      onError: (error, context) => {
        reports.push({ error, context })
      },
    })

    await requestWorkflowRun(sixb, workflow, "wfrun_worker_resume_failed", {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    })

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_resume_failed",
        }),
      (value) => value?.status === "waiting"
    )
    await sixb.storage.workflowInterventions!.submit({
      projectId: sixb.id,
      id: "wfrun_worker_resume_failed:intervention:1",
      response: {
        approvedInvoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
      },
    })
    await sixb.queues.workflows.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "workflow.run.resume.requested",
          payload: {
            runId: "wfrun_worker_resume_failed",
            resume: {
              kind: "intervention",
              interventionId: "wfrun_worker_resume_failed:intervention:1",
            },
          },
        },
      ],
    })

    const run = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_resume_failed",
        }),
      (value) => value?.status === "failed"
    )
    const reported = await waitFor(
      async () => reports,
      (value) => value.length === 1
    )

    expect(run?.error).toBe(resumeError.message)
    expect(reported[0]?.error).toBe(resumeError)
    expect(reported[0]?.context).toMatchObject({
      attempt: 1,
      run: {
        kind: "workflow",
        runId: "wfrun_worker_resume_failed",
        workflowId: workflow.id,
      },
    })
  })

  test("keeps the run recoverable without reporting a failure on worker shutdown", async () => {
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    const workflow = defineWorkflow("cancel-workflow").input({}).then(slowStep)
    const sixb = createSixb({
      workflows: [workflow],
      onError: (error, context) => {
        reports.push({ error, context })
      },
    })
    await requestWorkflowRun(sixb, workflow, "wfrun_worker_cancelled", {})

    const worker = new WorkflowWorker(sixb)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_cancelled",
        }),
      (value) => value?.status === "running"
    )

    await worker.stop()

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_worker_cancelled",
    })
    expect(run?.status).toBe("running")
    await Bun.sleep(0)
    expect(reports).toHaveLength(0)

    const interruptedEvents = await sixb.events.read({
      types: [
        "workflow.run.started",
        "workflow.run.node.started",
        "workflow.run.node.finished",
        "workflow.run.finished",
      ],
    })
    expect(interruptedEvents.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
    ])

    const replacement = new WorkflowWorker(sixb)
    workers.push(replacement)
    await replacement.start()
    const recovered = await waitFor(
      () =>
        sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
          id: "wfrun_worker_cancelled",
        }),
      (value) => value?.status === "succeeded"
    )

    expect(recovered).toMatchObject({ status: "succeeded", attempt: 2 })
    expect(reports).toHaveLength(0)

    const events = await sixb.events.read({
      types: [
        "workflow.run.started",
        "workflow.run.node.started",
        "workflow.run.node.finished",
        "workflow.run.finished",
      ],
    })
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.finished",
    ])
    expect(events[2]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_cancelled",
      nodeRunId: "wfrun_worker_cancelled:node:0",
      status: "succeeded",
    })
    expect(events[3]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_cancelled",
      status: "succeeded",
      finishedAt: expect.any(String),
    })

    const claimed = await sixb.queues.workflows.claim({
      projectId: sixb.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })
})
