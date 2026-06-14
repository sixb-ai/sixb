import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type ActionRunStorage,
  defineIntervention,
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
  param,
  prop,
  ref,
  Sixb,
  type WorkflowDefinition,
  type WorkflowRunStorage,
  WorkflowValidationError,
} from "@sixb/core"
import {
  EventsRuntimeWorkflowRunObserver,
  runWorkflowJob,
  runWorkflowResumeJob,
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

const reviewInvoiceDecision = defineIntervention("review-invoice-decision")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .response({
    approved: "boolean",
  })
  .defaults(({ input }) => ({
    approved: input.confidence >= 0.95,
  }))

const reviewBeforeAttach = defineIntervention("review-before-attach")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .response({
    invoice: ref(Invoice),
  })
  .defaults(({ input }) => ({
    invoice: input.invoice,
  }))

const attachReviewedInvoice = defineWorkflowStep("attach-reviewed-invoice")
  .input({
    invoice: ref(Invoice),
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
const attachInvoice: ActionDefinition = {
  kind: "action",
  id: "attach-invoice",
  binding: { kind: "object", objectType: Transaction },
  target: Transaction,
  params: {
    invoice: param(ref(Invoice)),
  },
  phases: {
    validate: [],
    writeback: () => {
      actionHandlerCalls += 1
    },
  },
}

function createSixb(options: {
  readonly workflows?: readonly WorkflowDefinition[]
  readonly actions?: readonly ActionDefinition[]
}) {
  return new Sixb({
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

function createRuntime(sixb: {
  readonly projectId: string
  readonly ontology: WorkflowWorkerContext["ontology"]
  readonly actionRegistry: WorkflowWorkerContext["actionRegistry"]
  readonly events: WorkflowWorkerContext["events"]
  readonly storage: WorkflowWorkerContext["storage"]
  readonly lakeStorage: WorkflowWorkerContext["lakeStorage"]
  readonly blobStorage: WorkflowWorkerContext["blobStorage"]
  readonly queues: WorkflowWorkerContext["queues"]
  readonly rules?: WorkflowWorkerContext["rules"]
  readonly workflows: { getById(workflowId: string): WorkflowDefinition | null }
}) {
  return {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobStorage,
    queues: sixb.queues,
    rules: sixb.rules,
    workflowRuns: requireWorkflowRunsStorage(sixb),
    sixb: sixb as unknown as Sixb<readonly OntologySource[]>,
    getWorkflowById(workflowId: string) {
      return sixb.workflows.getById(workflowId)
    },
  } satisfies WorkflowWorkerContext
}

async function completeRequestedActions(
  sixb: {
    readonly id: string
    readonly events: EventsRuntime
    readonly storage: { readonly actionRuns?: ActionRunStorage }
  },
  status: "succeeded" | "failed",
  errorMessage = "action failed"
): Promise<() => void> {
  const actionRuns = sixb.storage.actionRuns
  if (!actionRuns) {
    throw new Error("Expected action run storage in test runtime.")
  }

  return sixb.events.subscribe(
    {
      types: ["action.requested"],
    },
    (events) => {
      for (const event of events) {
        if (event.type !== "action.requested") {
          continue
        }

        void (async () => {
          const run = await actionRuns.getById({
            projectId: sixb.id,
            id: event.payload.runId,
          })
          if (run?.status === "queued") {
            await actionRuns.start({
              projectId: sixb.id,
              id: event.payload.runId,
            })
          }

          await actionRuns.finish(
            status === "succeeded"
              ? {
                  projectId: sixb.id,
                  id: event.payload.runId,
                  status: "succeeded",
                  finishedAt: new Date("2026-05-08T10:00:00.000Z"),
                }
              : {
                  projectId: sixb.id,
                  id: event.payload.runId,
                  status: "failed",
                  finishedAt: new Date("2026-05-08T10:00:00.000Z"),
                  error: {
                    message: errorMessage,
                    phase: "writeback",
                  },
                }
          )

          await sixb.events.append({
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
                        phase: "writeback",
                      },
                      finishedAt: "2026-05-08T10:00:00.000Z",
                    },
                  },
            ],
          })
        })()
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
    const sixb = createSixb({ workflows: [workflow] })
    const calls: string[] = []
    const observer: WorkflowRunObserver = {
      async onRunStarted(run) {
        const stored = await sixb.storage.workflowRuns!.getById({
          projectId: sixb.id,
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
    await sixb.storage.workflowRuns!.queue({
      id: "wfrun_observed",
      projectId: sixb.id,
      workflowId: workflow.id,
      input: workflowInput,
      queuedAt: new Date("2026-05-08T09:59:00.000Z"),
    })

    await runWorkflowJob({
      runtime: createRuntime(sixb),
      job: {
        id: "wfrun_observed",
        workflowId: workflow.id,
        input: workflowInput,
      },
      observer,
    })

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
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
    const sixb = createSixb({ workflows: [workflow] })
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
        runtime: createRuntime(sixb),
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
    const sixb = createSixb({ workflows: [workflow] })

    const result = await runWorkflowJob({
      runtime: createRuntime(sixb),
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

  test("suspends workflow runs at intervention nodes", async () => {
    const workflow = defineWorkflow("intervention-suspends")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewBeforeAttach)
    const sixb = createSixb({ workflows: [workflow] })

    const result = await runWorkflowJob({
      runtime: createRuntime(sixb),
      job: {
        id: "wfrun_intervention_waiting",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
      observer: new EventsRuntimeWorkflowRunObserver(sixb.events),
    })

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_intervention_waiting",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_intervention_waiting",
      order: "asc",
    })
    const interventions = await sixb.storage.workflowInterventions!.list({
      projectId: sixb.id,
    })
    const events = await sixb.events.read({
      types: [
        "workflow.run.started",
        "workflow.run.node.started",
        "workflow.run.node.finished",
        "workflow.intervention.requested",
        "workflow.run.node.waiting",
        "workflow.run.waiting",
        "workflow.run.finished",
      ],
    })

    expect(result.status).toBe("waiting")
    expect(run?.status).toBe("waiting")
    expect(nodes.nodes.map((node) => `${node.nodeId}:${node.status}`)).toEqual([
      "find-best-invoice:succeeded",
      "review-before-attach:waiting",
    ])
    expect(interventions.total).toBe(1)
    expect(interventions.interventions[0]).toMatchObject({
      id: "wfrun_intervention_waiting:intervention:1",
      workflowId: workflow.id,
      workflowRunId: "wfrun_intervention_waiting",
      nodeRunId: "wfrun_intervention_waiting:node:1",
      nodeIndex: 1,
      nodeId: "review-before-attach",
      nodeKey: "reviewBeforeAttach",
      interventionId: "review-before-attach",
      status: "pending",
      input: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        confidence: 0.98,
      },
      defaultResponse: {
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
    expect(events[4]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: "wfrun_intervention_waiting",
      nodeRunId: "wfrun_intervention_waiting:node:1",
      interventionId: "review-before-attach",
      pendingInterventionId: "wfrun_intervention_waiting:intervention:1",
    })
  })

  test("resumes submitted interventions and continues workflow dataflow", async () => {
    const workflow = defineWorkflow("intervention-resumes")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewBeforeAttach)
      .then(attachReviewedInvoice, ({ steps }) => ({
        invoice: steps.reviewBeforeAttach.invoice,
      }))
    const sixb = createSixb({ workflows: [workflow] })
    const runtime = createRuntime(sixb)
    const observer = new EventsRuntimeWorkflowRunObserver(sixb.events)

    const waiting = await runWorkflowJob({
      runtime,
      job: {
        id: "wfrun_resume",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
      observer,
    })

    expect(waiting.status).toBe("waiting")
    await sixb.storage.workflowInterventions!.submit({
      projectId: sixb.id,
      id: "wfrun_resume:intervention:1",
      response: {
        invoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
      },
      submittedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const resumed = await runWorkflowResumeJob({
      runtime,
      job: {
        id: "wfrun_resume",
        workflowId: workflow.id,
        pendingInterventionId: "wfrun_resume:intervention:1",
      },
      observer,
    })

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_resume",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_resume",
      order: "asc",
    })
    const events = await sixb.events.read({
      types: ["workflow.run.node.finished", "workflow.run.node.started", "workflow.run.finished"],
    })

    expect(resumed.status).toBe("succeeded")
    expect(run?.status).toBe("succeeded")
    expect(nodes.nodes.map((node) => `${node.nodeId}:${node.status}`)).toEqual([
      "find-best-invoice:succeeded",
      "review-before-attach:succeeded",
      "attach-reviewed-invoice:succeeded",
    ])
    expect(nodes.nodes[1]?.output).toEqual({
      invoice: { objectTypeId: "Invoice", primaryId: "inv_reviewed" },
    })
    expect(resumed.steps.reviewBeforeAttach.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv_reviewed",
    })
    expect(resumed.steps.attachReviewedInvoice.invoice).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv_reviewed",
    })
    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.finished",
    ])

    const duplicate = await runWorkflowResumeJob({
      runtime,
      job: {
        id: "wfrun_resume",
        workflowId: workflow.id,
        pendingInterventionId: "wfrun_resume:intervention:1",
      },
      observer,
    })
    const afterDuplicate = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_resume",
      order: "asc",
    })

    expect(duplicate.status).toBe("succeeded")
    expect(afterDuplicate.nodes.map((node) => node.id)).toEqual(nodes.nodes.map((node) => node.id))
  })

  test("keeps runs waiting when submitted intervention responses are invalid", async () => {
    const workflow = defineWorkflow("intervention-invalid-response")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewBeforeAttach)
      .then(attachReviewedInvoice, ({ steps }) => ({
        invoice: steps.reviewBeforeAttach.invoice,
      }))
    const sixb = createSixb({ workflows: [workflow] })
    const runtime = createRuntime(sixb)

    await runWorkflowJob({
      runtime,
      job: {
        id: "wfrun_invalid_resume_response",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
    })
    await sixb.storage.workflowInterventions!.submit({
      projectId: sixb.id,
      id: "wfrun_invalid_resume_response:intervention:1",
      response: {
        invoice: { objectTypeId: "Transaction", primaryId: "txn_1" },
      },
    })

    await expect(
      runWorkflowResumeJob({
        runtime,
        job: {
          id: "wfrun_invalid_resume_response",
          workflowId: workflow.id,
          pendingInterventionId: "wfrun_invalid_resume_response:intervention:1",
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_invalid_resume_response",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_invalid_resume_response",
      order: "asc",
    })

    expect(run?.status).toBe("waiting")
    expect(nodes.nodes.map((node) => `${node.nodeId}:${node.status}`)).toEqual([
      "find-best-invoice:succeeded",
      "review-before-attach:waiting",
    ])
  })

  test("validates workflow input before starting the run", async () => {
    const workflow = defineWorkflow("requires-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_invalid_input",
          workflowId: workflow.id,
          input: {},
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const runs = await sixb.storage.workflowRuns!.list({
      projectId: sixb.id,
    })
    expect(runs.total).toBe(0)
  })

  test("marks queued runs failed when validation fails before start", async () => {
    const workflow = defineWorkflow("queued-invalid-input")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })
    const observerCalls: string[] = []

    await sixb.storage.workflowRuns!.queue({
      id: "wfrun_queued_invalid_input",
      projectId: sixb.id,
      workflowId: workflow.id,
      input: {},
    })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
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

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_queued_invalid_input",
    })
    expect(run?.status).toBe("failed")
    expect(observerCalls).toHaveLength(1)
    expect(observerCalls[0]).toContain("failed:[Sixb] Missing required field")
    expect(observerCalls[0]).toContain('Workflow "queued-invalid-input" input.transaction')
  })

  test("marks the active step and workflow failed when step output validation fails", async () => {
    const workflow = defineWorkflow("invalid-output-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(invalidOutputStep)
    const sixb = createSixb({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_invalid_output",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toBeInstanceOf(WorkflowValidationError)

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_invalid_output",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
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
    const sixb = createSixb({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_step_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toThrow("step exploded")

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_step_failed",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
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
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    await sixb.upsertObject("Transaction", { id: "txn_1" })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_action",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await sixb.events.read({
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

  test("parks workflow runs at intervention nodes and creates pending interventions", async () => {
    const workflow = defineWorkflow("review-invoice-intervention-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(reviewInvoiceDecision)
    const sixb = createSixb({ workflows: [workflow] })

    const result = await runWorkflowJob({
      runtime: createRuntime(sixb),
      job: {
        id: "wfrun_intervention",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
      observer: new EventsRuntimeWorkflowRunObserver(sixb.events),
    })

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_intervention",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_intervention",
      order: "asc",
    })
    const intervention = await sixb.storage.workflowInterventions!.getById({
      projectId: sixb.id,
      id: "wfrun_intervention:intervention:1",
    })
    const events = await sixb.events.read({
      topics: ["workflows"],
    })

    expect(result.status).toBe("waiting")
    expect(run?.status).toBe("waiting")
    expect(result.nodes.map((node) => node.status)).toEqual(["succeeded", "waiting"])
    expect(nodes.nodes.map((node) => [node.nodeType, node.status])).toEqual([
      ["step", "succeeded"],
      ["intervention", "waiting"],
    ])
    expect(intervention).toMatchObject({
      workflowId: workflow.id,
      workflowRunId: "wfrun_intervention",
      nodeRunId: "wfrun_intervention:node:1",
      interventionId: "review-invoice-decision",
      status: "pending",
      input: {
        confidence: 0.98,
        invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
      },
      defaultResponse: { approved: true },
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
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    await sixb.upsertObject("Transaction", { id: "txn_1" })
    const unsubscribe = await completeRequestedActions(sixb, "failed", "attach failed")

    try {
      await expect(
        runWorkflowJob({
          runtime: createRuntime(sixb),
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

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_action_run_failed",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_action_run_failed",
      order: "asc",
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes.map((node) => node.status)).toEqual(["succeeded", "failed"])
    expect(nodes.nodes[1]?.error).toBe("attach failed")
  })

  test("marks action node and workflow failed when the action worker rejects the target", async () => {
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
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    const unsubscribe = await completeRequestedActions(
      sixb,
      "failed",
      "Object not found for action request"
    )

    try {
      await expect(
        runWorkflowJob({
          runtime: createRuntime(sixb),
          job: {
            id: "wfrun_action_failed",
            workflowId: workflow.id,
            input: {
              transaction: { objectTypeId: "Transaction", primaryId: "missing" },
            },
          },
        })
      ).rejects.toThrow("Object not found for action request")
    } finally {
      unsubscribe()
    }

    const run = await sixb.storage.workflowRuns!.getById({
      projectId: sixb.id,
      id: "wfrun_action_failed",
    })
    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_action_failed",
      order: "asc",
    })
    const events = await sixb.events.read({
      types: ["action.requested"],
    })
    expect(run?.status).toBe("failed")
    expect(nodes.nodes.map((node) => node.status)).toEqual(["succeeded", "failed"])
    expect(events).toHaveLength(1)
  })

  test("fails clearly when the workflow is missing", async () => {
    const sixb = createSixb({})

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_missing",
          workflowId: "missing-workflow",
          input: {},
        },
      })
    ).rejects.toThrow("[SixbWorkflowWorker] Unknown workflow 'missing-workflow'.")
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
    const sixb = createSixb({ workflows: [workflow] })

    await expect(
      runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_mapper_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
    ).rejects.toThrow("mapper exploded")

    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: "wfrun_mapper_failed",
      order: "asc",
    })
    expect(nodes.nodes.map((node) => node.nodeId)).toEqual(["find-best-invoice"])
  })
})
