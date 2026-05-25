import { describe, expect, test } from "bun:test"
import {
  actionParam,
  defineAction,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  type EventsRuntime,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologySource,
  Pario,
  prop,
  ref,
  type WorkflowDefinition,
  type WorkflowRunStorage,
  WorkflowValidationError,
} from "@pario/core"
import {
  runWorkflowJob,
  type WorkflowRunObserver,
  type WorkflowWorkerContext,
  WorkflowWorkerError,
} from "../src"

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
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(({ input }) => ({
    transaction: input.transaction,
    invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
    confidence: 0.98,
  }))

const reviewInvoiceMatch = defineWorkflowStep("review-invoice-match")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(({ input }) => ({
    invoice: input.invoice,
  }))

const failingStep = defineWorkflowStep("explode")
  .input({
    invoice: ref(Invoice),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(() => {
    throw new Error("step exploded")
  })

const invalidOutputStep = defineWorkflowStep("invalid-output")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    invoice: ref(Invoice),
  })
  .run(() => ({
    invoice: { objectTypeId: "Transaction", primaryId: "txn_1" } as unknown as {
      objectTypeId: "Invoice"
      primaryId: string
    },
  }))

let actionHandlerCalls = 0
const attachInvoice = defineAction("attach-invoice")
  .target(Transaction)
  .params({
    invoice: actionParam(ref(Invoice), { required: true }),
  })
  .run(() => {
    actionHandlerCalls += 1
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

function requireWorkflowRunsStorage(input: {
  readonly storage: { readonly workflowRuns?: WorkflowRunStorage }
}): WorkflowRunStorage {
  const workflowRuns = input.storage.workflowRuns
  if (!workflowRuns) {
    throw new Error("Expected workflow run storage in test runtime.")
  }
  return workflowRuns
}

function createRuntime(pario: {
  readonly projectId: string
  readonly ontology: WorkflowWorkerContext["ontology"]
  readonly actionRegistry: WorkflowWorkerContext["actionRegistry"]
  readonly events: WorkflowWorkerContext["events"]
  readonly storage: WorkflowWorkerContext["storage"]
  readonly lakeStorage: WorkflowWorkerContext["lakeStorage"]
  readonly blobStorage: WorkflowWorkerContext["blobStorage"]
  readonly queues: WorkflowWorkerContext["queues"]
  readonly rules?: WorkflowWorkerContext["rules"]
  getWorkflowById: WorkflowWorkerContext["getWorkflowById"]
}) {
  return {
    projectId: pario.projectId,
    ontology: pario.ontology,
    actionRegistry: pario.actionRegistry,
    events: pario.events,
    storage: pario.storage,
    lakeStorage: pario.lakeStorage,
    blobStorage: pario.blobStorage,
    queues: pario.queues,
    rules: pario.rules,
    workflowRuns: requireWorkflowRunsStorage(pario),
    pario: pario as unknown as Pario<readonly OntologySource[]>,
    getWorkflowById(workflowId: string) {
      return pario.getWorkflowById(workflowId)
    },
  } satisfies WorkflowWorkerContext
}

async function completeRequestedActions(
  pario: { readonly id: string; readonly events: EventsRuntime },
  status: "succeeded" | "failed",
  errorMessage = "action failed"
): Promise<() => void> {
  return pario.events.subscribe(
    {
      types: ["action.requested"],
    },
    (events) => {
      for (const event of events) {
        if (event.type !== "action.requested") {
          continue
        }

        void pario.events.append({
          events: [
            status === "succeeded"
              ? {
                  type: "action.completed",
                  payload: {
                    actionId: event.payload.actionId,
                    runId: event.payload.runId,
                    subject: event.payload.subject,
                    finishedAt: "2026-05-08T10:00:00.000Z",
                  },
                }
              : {
                  type: "action.failed",
                  payload: {
                    actionId: event.payload.actionId,
                    runId: event.payload.runId,
                    subject: event.payload.subject,
                    error: {
                      message: errorMessage,
                      phase: "handler",
                    },
                    finishedAt: "2026-05-08T10:00:00.000Z",
                  },
                },
          ],
        })
      }
    }
  )
}

describe("runWorkflowJob", () => {
  test("notifies lifecycle observer after storage transitions", async () => {
    const workflow = defineWorkflow("observed-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })
    const calls: string[] = []
    const observer: WorkflowRunObserver = {
      async onRunStarted(run) {
        const stored = await pario.storage.workflowRuns!.getById({
          projectId: pario.id,
          id: run.id,
        })
        calls.push(`run-started:${stored?.status}`)
      },
      async onNodeStarted(node, context) {
        calls.push(`node-started:${node.nodeIndex}/${context.totalNodes}:${node.status}`)
      },
      async onNodeFinished(node) {
        calls.push(`node-finished:${node.nodeIndex}:${node.status}`)
      },
      async onRunFinished(run) {
        calls.push(`run-finished:${run.status}`)
      },
    }
    const workflowInput = {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    }
    await pario.storage.workflowRuns!.queue({
      id: "wfrun_observed",
      projectId: pario.id,
      workflowId: workflow.id,
      input: workflowInput,
      queuedAt: new Date("2026-05-08T09:59:00.000Z"),
    })

    await runWorkflowJob({
      runtime: createRuntime(pario),
      job: {
        id: "wfrun_observed",
        workflowId: workflow.id,
        input: workflowInput,
      },
      observer,
    })

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_observed",
    })

    expect(run?.queuedAt?.toISOString()).toBe("2026-05-08T09:59:00.000Z")
    expect(calls).toEqual([
      "run-started:running",
      "node-started:0/1:running",
      "node-finished:0:succeeded",
      "run-finished:succeeded",
    ])
  })

  test("does not fail a workflow when lifecycle observer notification fails", async () => {
    const workflow = defineWorkflow("observer-fails")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })
    const observer: WorkflowRunObserver = {
      async onRunStarted() {
        throw new Error("observer failed")
      },
      onNodeStarted: async () => undefined,
      onNodeFinished: async () => undefined,
      onRunFinished: async () => undefined,
    }

    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_observer_fails",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
        observer,
      })

      expect(result.run.status).toBe("succeeded")
    } finally {
      console.error = originalConsoleError
    }
  })

  test("runs direct and mapped step dataflow sequentially", async () => {
    const workflow = defineWorkflow("reconcile-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoiceMatch, ({ input, steps }) => ({
        transaction: input.transaction,
        invoice: steps.findBestInvoice.invoice,
        confidence: steps.findBestInvoice.confidence,
      }))
    const pario = createPario({ workflows: [workflow] })

    const result = await runWorkflowJob({
      runtime: createRuntime(pario),
      job: {
        id: "wfrun_1",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.nodes.map((node) => node.nodeId)).toEqual([
      "find-best-invoice",
      "review-invoice-match",
    ])
    expect(result.steps.findBestInvoice.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    expect(result.steps.reviewInvoiceMatch.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
  })

  test("validates workflow input before starting the run", async () => {
    const workflow = defineWorkflow("requires-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_invalid_input",
          workflowId: workflow.id,
          input: {},
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const runs = await pario.storage.workflowRuns!.list({
      projectId: pario.id,
    })
    expect(runs.total).toBe(0)
  })

  test("marks queued runs failed when validation fails before start", async () => {
    const workflow = defineWorkflow("queued-invalid-input")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const pario = createPario({ workflows: [workflow] })
    const observerCalls: string[] = []

    await pario.storage.workflowRuns!.queue({
      id: "wfrun_queued_invalid_input",
      projectId: pario.id,
      workflowId: workflow.id,
      input: {},
    })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_queued_invalid_input",
          workflowId: workflow.id,
          input: {},
        },
        observer: {
          onRunStarted: async () => undefined,
          onNodeStarted: async () => undefined,
          onNodeFinished: async () => undefined,
          onRunFinished: async (run) => {
            observerCalls.push(`${run.status}:${run.error}`)
          },
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_queued_invalid_input",
    })
    expect(run?.status).toBe("failed")
    expect(observerCalls).toHaveLength(1)
    expect(observerCalls[0]).toContain("failed:[Pario] Missing required field")
    expect(observerCalls[0]).toContain('Workflow "queued-invalid-input" input.transaction')
  })

  test("marks the active step and workflow failed when step output validation fails", async () => {
    const workflow = defineWorkflow("invalid-output-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(invalidOutputStep)
    const pario = createPario({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_invalid_output",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_invalid_output",
    })
    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_invalid_output",
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes).toHaveLength(1)
    expect(nodes.nodes[0]?.status).toBe("failed")
    expect(nodes.nodes[0]?.error).toContain(
      'Workflow "invalid-output-workflow" step "invalid-output" output.invoice'
    )
  })

  test("marks the active step and workflow failed when a step handler throws", async () => {
    const workflow = defineWorkflow("failing-step-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(failingStep, ({ steps }) => ({
        invoice: steps.findBestInvoice.invoice,
      }))
    const pario = createPario({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_step_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toThrow("step exploded")

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_step_failed",
    })
    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_step_failed",
      order: "asc",
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes.map((node) => node.status)).toEqual(["succeeded", "failed"])
    expect(nodes.nodes[1]?.error).toBe("step exploded")
  })

  test("waits for action nodes to finish without running the action handler inline", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("attach-invoice-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        target: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const pario = createPario({ actions: [attachInvoice], workflows: [workflow] })
    await pario.upsertObject("Transaction", { id: "txn_1" })
    const unsubscribe = await completeRequestedActions(pario, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_action",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await pario.events.read({
        types: ["action.requested", "action.completed"],
      })
      expect(actionHandlerCalls).toBe(0)
      expect(events.map((event) => event.type)).toEqual(["action.requested", "action.completed"])
      expect(events[0]?.payload).toMatchObject({
        subject: {
          kind: "object",
          objectTypeId: "Transaction",
          primaryId: "txn_1",
        },
        actionId: "attach-invoice",
        runId: "wfrun_action:action:1",
      })
      expect(result.nodes[1]?.status).toBe("succeeded")
    } finally {
      unsubscribe()
    }
  })

  test("marks action node and workflow failed when the action run fails", async () => {
    const workflow = defineWorkflow("attach-invoice-fails-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        target: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const pario = createPario({ actions: [attachInvoice], workflows: [workflow] })
    await pario.upsertObject("Transaction", { id: "txn_1" })
    const unsubscribe = await completeRequestedActions(pario, "failed", "attach failed")

    try {
      await expect(
        runWorkflowJob({
          runtime: createRuntime(pario),
          job: {
            id: "wfrun_action_run_failed",
            workflowId: workflow.id,
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
            },
          },
        })
      ).rejects.toThrow("attach failed")
    } finally {
      unsubscribe()
    }

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_action_run_failed",
    })
    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_action_run_failed",
      order: "asc",
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes.map((node) => node.status)).toEqual(["succeeded", "failed"])
    expect(nodes.nodes[1]?.error).toBe("attach failed")
  })

  test("marks action node and workflow failed when action request validation fails", async () => {
    const workflow = defineWorkflow("missing-target-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        target: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const pario = createPario({ actions: [attachInvoice], workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_action_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "missing" },
          },
        },
      })
    ).rejects.toThrow("Object not found for action request")

    const run = await pario.storage.workflowRuns!.getById({
      projectId: pario.id,
      id: "wfrun_action_failed",
    })
    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_action_failed",
      order: "asc",
    })
    const events = await pario.events.read({
      types: ["action.requested"],
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes.map((node) => node.status)).toEqual(["succeeded", "failed"])
    expect(events).toHaveLength(0)
  })

  test("fails clearly when the workflow is missing", async () => {
    const pario = createPario({})

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_missing",
          workflowId: "missing-workflow",
          input: {},
        },
      })
    ).rejects.toThrow("[ParioWorkflowWorker] Unknown workflow 'missing-workflow'.")
  })

  test("does not invent a node row when a mapper throws before producing input", async () => {
    const workflow = defineWorkflow("mapper-throws")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoiceMatch, () => {
        throw new WorkflowWorkerError("mapper exploded")
      })
    const pario = createPario({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(pario),
        job: {
          id: "wfrun_mapper_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toThrow("mapper exploded")

    const nodes = await pario.storage.workflowRuns!.nodes.list({
      projectId: pario.id,
      workflowRunId: "wfrun_mapper_failed",
      order: "asc",
    })
    expect(nodes.nodes.map((node) => node.nodeId)).toEqual(["find-best-invoice"])
  })
})
