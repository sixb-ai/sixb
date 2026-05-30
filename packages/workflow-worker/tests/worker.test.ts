import { afterEach, describe, expect, test } from "bun:test"
import {
  actionParam,
  defineAction,
  defineIntervention,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Pario,
  prop,
  ref,
  type WorkflowDefinition,
} from "@pario/core"
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

const failingStep = defineWorkflowStep("explode")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(() => {
    throw new Error("workflow exploded")
  })

const attachInvoice = defineAction("attach-invoice")
  .target(Transaction)
  .params({
    invoice: actionParam(ref(Invoice), { required: true }),
  })
  .run(() => {})

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

function createPario(options: {
  readonly workflows?: readonly WorkflowDefinition[]
  readonly actions?: readonly (typeof attachInvoice)[]
}) {
  return new Pario({
    id: "workflow-worker-tests",
    ontology: [Transaction, Invoice],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    actions: options.actions ?? [],
    workflows: options.workflows ?? [],
  })
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
    expect(() => new WorkflowWorker(createPario({}))).toThrow("No workflow definitions")

    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })
    const withoutWorkflowRuns = {
      id: pario.id,
      projectId: pario.projectId,
      ontology: pario.ontology,
      actionRegistry: pario.actionRegistry,
      events: pario.events,
      storage: {
        ...pario.storage,
        workflowRuns: undefined,
      },
      lakeStorage: pario.lakeStorage,
      blobStorage: pario.blobStorage,
      queues: pario.queues,
      workflows: pario.workflows,
    }

    expect(() => new WorkflowWorker(withoutWorkflowRuns)).toThrow("storage.workflowRuns")

    const interventionWorkflow = defineWorkflow("review-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoice)
    const parioWithIntervention = createPario({ workflows: [interventionWorkflow] })
    const withoutWorkflowInterventions = {
      id: parioWithIntervention.id,
      projectId: parioWithIntervention.projectId,
      ontology: parioWithIntervention.ontology,
      actionRegistry: parioWithIntervention.actionRegistry,
      events: parioWithIntervention.events,
      storage: {
        ...parioWithIntervention.storage,
        workflowInterventions: undefined,
      },
      lakeStorage: parioWithIntervention.lakeStorage,
      blobStorage: parioWithIntervention.blobStorage,
      queues: parioWithIntervention.queues,
      workflows: parioWithIntervention.workflows,
    }

    expect(() => new WorkflowWorker(withoutWorkflowInterventions)).toThrow(
      "storage.workflowInterventions"
    )
  })

  test("processes queued workflow jobs and emits workflow lifecycle events", async () => {
    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })
    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_success",
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
            },
          },
        },
      ],
    })

    const worker = new WorkflowWorker(pario)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_success",
        }),
      (value) => value?.status === "succeeded"
    )
    expect(run?.workflowId).toBe(workflow.id)

    const events = await waitFor(
      () =>
        pario.events.read({
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

    const claimed = await pario.queues.workflows.claim({
      projectId: pario.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("fails the queue job and emits failed workflow lifecycle events", async () => {
    const workflow = defineWorkflow("failing-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(failingStep)
    const pario = createPario({ workflows: [workflow] })
    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_failed",
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
            },
          },
        },
      ],
    })

    const worker = new WorkflowWorker(pario)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_failed",
        }),
      (value) => value?.status === "failed"
    )
    expect(run?.error).toBe("workflow exploded")

    const events = await waitFor(
      () =>
        pario.events.read({
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

    const claimed = await pario.queues.workflows.claim({
      projectId: pario.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
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
    const pario = createPario({ workflows: [workflow] })
    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_waiting",
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
            },
          },
        },
      ],
    })

    const worker = new WorkflowWorker(pario)
    workers.push(worker)
    await worker.start()

    const run = await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_waiting",
        }),
      (value) => value?.status === "waiting"
    )
    const interventions = await waitFor(
      () =>
        pario.storage.workflowInterventions!.list({
          projectId: pario.id,
          workflowRunId: "wfrun_worker_waiting",
        }),
      (value) => value.total === 1
    )
    const events = await waitFor(
      () =>
        pario.events.read({
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

    const claimed = await pario.queues.workflows.claim({
      projectId: pario.id,
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
    const pario = createPario({ workflows: [workflow] })

    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_resume",
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
            },
          },
        },
      ],
    })

    const worker = new WorkflowWorker(pario)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_resume",
        }),
      (value) => value?.status === "waiting"
    )

    await pario.storage.workflowInterventions!.submit({
      projectId: pario.id,
      id: "wfrun_worker_resume:intervention:1",
      response: {
        approvedInvoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
      },
    })
    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.resume.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_resume",
            pendingInterventionId: "wfrun_worker_resume:intervention:1",
          },
        },
      ],
    })

    const run = await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_resume",
        }),
      (value) => value?.status === "succeeded"
    )
    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_worker_resume",
      order: "asc",
    })
    const events = await waitFor(
      () =>
        pario.events.read({
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

    const claimed = await pario.queues.workflows.claim({
      projectId: pario.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })

  test("cancels the run and fails the queue job on worker shutdown", async () => {
    const workflow = defineWorkflow("cancel-workflow").input({}).then(slowStep)
    const pario = createPario({ workflows: [workflow] })
    await pario.queues.workflows.enqueue({
      projectId: pario.id,
      jobs: [
        {
          type: "workflow.run.requested",
          payload: {
            workflowId: workflow.id,
            runId: "wfrun_worker_cancelled",
            input: {},
          },
        },
      ],
    })

    const worker = new WorkflowWorker(pario)
    workers.push(worker)
    await worker.start()

    await waitFor(
      () =>
        pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: "wfrun_worker_cancelled",
        }),
      (value) => value?.status === "running"
    )

    await worker.stop()

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_worker_cancelled",
    })
    expect(run?.status).toBe("cancelled")

    const events = await pario.events.read({
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
      status: "cancelled",
    })
    expect(events[3]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_worker_cancelled",
      status: "cancelled",
      finishedAt: expect.any(String),
      error: "Workflow worker aborted.",
    })

    const claimed = await pario.queues.workflows.claim({
      projectId: pario.id,
      workerId: "observer",
    })
    expect(claimed).toHaveLength(0)
  })
})
