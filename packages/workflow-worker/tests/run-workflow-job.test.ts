import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type AgentDefinition,
  type DomainEventLog,
  defineAction,
  defineAgent,
  defineAgentStep,
  defineIntervention,
  defineObjectType,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  param,
  prop,
  ref,
  SixbHost,
  type WorkflowDefinition,
  WorkflowValidationError,
} from "@sixb/core"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import { snapshotWorkflowInput } from "@sixb/core/internal/workflows"
import type {
  ActionRunStorage,
  QueueWorkflowRunInput,
  WorkflowRunStorage,
} from "@sixb/core/storage"
import { createTestSixb, createTestWorkflowExecution } from "@sixb/core/testing"
import { WorkflowWorkerError } from "../src/errors"
import { EventsRuntimeWorkflowRunObserver } from "../src/events"
import { runWorkflowJob as executeWorkflowJob, runWorkflowResumeJob } from "../src/run-workflow-job"
import type { RunWorkflowJobInput, WorkflowRunObserver, WorkflowWorkerContext } from "../src/types"
import type { WorkflowWorkerHost } from "../src/worker"

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

const invoiceResolverAgent = defineAgent("invoice-resolver", {
  name: "Invoice resolver",
  model: {} as Parameters<typeof defineAgent>[1]["model"],
  instructions: "Resolve the best matching invoice.",
})

const resolveInvoiceWithAgent = defineAgentStep("resolve-invoice-with-agent", invoiceResolverAgent)
  .input({ transaction: ref(Transaction) })
  .output({ invoice: ref(Invoice), confidence: "double", reason: "string" })
  .prompt(({ input }) => `Resolve transaction '${input.transaction.primaryId}'.`)

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

const prepareAttachInvoiceAction = defineWorkflowStep("prepare-attach-invoice-action")
  .input({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .output({
    subject: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(({ input }) => ({
    subject: input.transaction,
    invoice: input.invoice,
    confidence: input.confidence,
  }))

const prepareInvoice = defineWorkflowStep("prepare-invoice")
  .input({
    transaction: ref(Transaction),
  })
  .output({
    amount: "double",
    transaction: ref(Transaction),
    extraContext: "string",
  })
  .run(({ input }) => ({
    amount: 250,
    transaction: input.transaction,
    extraContext: "ignored-by-action-request",
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
const attachInvoice = defineAction("attach-invoice")
  .on(Transaction)
  .params({
    invoice: param(ref(Invoice)),
  })
  .writeback(() => {
    actionHandlerCalls += 1
  })

const createInvoice = defineAction("create-invoice")
  .params({
    invoice: param(ref(Invoice)),
  })
  .writeback(() => {
    actionHandlerCalls += 1
  })

const createInvoiceFromTransaction = defineAction("create-invoice-from-transaction")
  .params({
    amount: param("double"),
    transaction: param(ref(Transaction)),
  })
  .writeback(() => {
    actionHandlerCalls += 1
  })

function createSixb(options: {
  readonly workflows?: readonly WorkflowDefinition[]
  readonly actions?: readonly ActionDefinition[]
  readonly agents?: readonly AgentDefinition[]
}) {
  return new SixbHost({
    id: "workflow-worker-tests",
    ontology: [Transaction, Invoice],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    actions: options.actions ?? [],
    agents: options.agents ?? [],
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

function createRuntime(host: WorkflowWorkerHost): WorkflowWorkerContext {
  const workflowId = host.definitions.workflows.list()[0]?.id ?? "missing-workflow"
  // Direct handler tests use one explicit trusted execution. Queue-worker tests exercise the real
  // per-delivery workflow id and run id binding in WorkflowWorker.execute.
  const primitive = {
    kind: "workflow" as const,
    id: workflowId,
    runId: "direct-workflow-job-test",
  }
  const execution = bindDurablePrimitiveExecution(host, {
    execution: {
      id: "direct-workflow-execution-test",
      projectId: host.id,
      executor: { type: "primitive", kind: primitive.kind, runId: primitive.runId },
      source: { type: "event", eventId: "direct-workflow-event-test" },
      correlationId: "direct-workflow-correlation-test",
      authorizationRef: { type: "trustedPrimitive", primitive },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    primitive,
  })
  return {
    projectId: host.id,
    ontology: host.definitions.ontology,
    storage: host.storage,
    queues: host.queues,
    workflowRuns: requireWorkflowRunsStorage(host),
    logging: host.logging,
    sixb: execution.sixb,
  }
}

async function queueWorkflowRunFixture(
  host: Pick<WorkflowWorkerContext, "storage">,
  input: Omit<QueueWorkflowRunInput, "executionId">
) {
  const executionId = await createTestWorkflowExecution(host.storage.executions, {
    projectId: input.projectId,
    workflowId: input.workflowId,
    runId: input.id,
  })
  return requireWorkflowRunsStorage(host).queue({ ...input, executionId })
}

async function runWorkflowJob(input: RunWorkflowJobInput) {
  const existing = await input.runtime.workflowRuns.getById({
    projectId: input.runtime.projectId,
    id: input.job.id,
  })
  if (!existing) {
    const workflow = input.runtime.sixb.workflows.getById(input.job.workflowId)
    if (!workflow) {
      return executeWorkflowJob(input)
    }
    const snapshot = snapshotWorkflowInput({
      workflow,
      value: input.job.input ?? {},
      valueTypesById: input.runtime.ontology.getValueTypesById(),
    })
    await queueWorkflowRunFixture(input.runtime, {
      id: input.job.id,
      projectId: input.runtime.projectId,
      workflowId: input.job.workflowId,
      input: snapshot,
    })
  }
  return executeWorkflowJob(input)
}

async function completeRequestedActions(
  sixb: {
    readonly id: string
    readonly events: DomainEventLog
    readonly storage: { readonly actionRuns?: ActionRunStorage }
  },
  status: "succeeded" | "failed",
  errorMessage = "action failed",
  options: { readonly effectsErrorMessage?: string } = {}
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

          if (status === "succeeded" && options.effectsErrorMessage) {
            await actionRuns.enterPhase({
              projectId: sixb.id,
              id: event.payload.runId,
              phase: "effects",
            })
            await actionRuns.recordEffects({
              projectId: sixb.id,
              id: event.payload.runId,
              status: "failed",
              error: {
                message: options.effectsErrorMessage,
                phase: "effects",
              },
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
    await queueWorkflowRunFixture(sixb, {
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

  test("treats duplicate requested jobs for an existing run as no-op", async () => {
    const workflow = defineWorkflow("idempotent-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })
    const job = {
      id: "wfrun_idempotent",
      workflowId: workflow.id,
      input: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
      },
    }

    const first = await runWorkflowJob({
      runtime: createRuntime(sixb),
      job,
    })
    const second = await runWorkflowJob({
      runtime: createRuntime(sixb),
      job,
    })

    expect(first.status).toBe("succeeded")
    expect(second.status).toBe("succeeded")
    expect(second.nodes).toHaveLength(1)

    const nodes = await sixb.storage.workflowRuns!.nodes.list({
      projectId: sixb.id,
      workflowRunId: job.id,
    })
    expect(nodes.total).toBe(1)
  })

  test("reclaims a running delivery and resumes from its deterministic node", async () => {
    const workflow = defineWorkflow("recover-running-workflow")
      .input({ transaction: ref(Transaction) })
      .then(findBestInvoice)
      .then(reviewInvoiceMatch)
    const sixb = createSixb({ workflows: [workflow] })
    const input = {
      transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
    } as const
    const firstOutput = {
      transaction: input.transaction,
      invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
      confidence: 0.98,
    } as const
    const runs = sixb.storage.workflowRuns!
    await queueWorkflowRunFixture(sixb, {
      id: "wfrun_recovered",
      projectId: sixb.id,
      workflowId: workflow.id,
      input,
    })
    await runs.start({
      id: "wfrun_recovered",
      projectId: sixb.id,
      execution: {
        token: "workflow-exec-old",
        queueLeaseExpiresAt: new Date("2026-05-08T10:05:00.000Z"),
      },
    })
    await runs.nodes.start({
      id: "wfrun_recovered:node:0",
      projectId: sixb.id,
      workflowRunId: "wfrun_recovered",
      workflowId: workflow.id,
      nodeIndex: 0,
      nodeType: "step",
      nodeId: findBestInvoice.id,
      nodeKey: "findBestInvoice",
      input,
      executionToken: "workflow-exec-old",
    })
    await runs.nodes.finish({
      id: "wfrun_recovered:node:0",
      projectId: sixb.id,
      status: "succeeded",
      output: firstOutput,
      executionToken: "workflow-exec-old",
    })
    await runs.nodes.start({
      id: "wfrun_recovered:node:1",
      projectId: sixb.id,
      workflowRunId: "wfrun_recovered",
      workflowId: workflow.id,
      nodeIndex: 1,
      nodeType: "step",
      nodeId: reviewInvoiceMatch.id,
      nodeKey: "reviewInvoiceMatch",
      input: firstOutput,
      executionToken: "workflow-exec-old",
    })

    const result = await runWorkflowJob({
      runtime: createRuntime(sixb),
      job: {
        id: "wfrun_recovered",
        workflowId: workflow.id,
        input,
        execution: {
          token: "workflow-exec-new",
          queueLeaseExpiresAt: new Date("2026-05-08T10:10:00.000Z"),
        },
      },
    })

    expect(result.status).toBe("succeeded")
    expect(result.nodes).toHaveLength(2)
    expect(result.steps.reviewInvoiceMatch).toEqual({ invoice: firstOutput.invoice })
    expect((await runs.getById({ projectId: sixb.id, id: result.id }))?.attempt).toBe(2)
  })

  test("does not fail a workflow when lifecycle observer notification fails", async () => {
    const workflow = defineWorkflow("observer-fails")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
    const sixb = createSixb({ workflows: [workflow] })
    const reportedFailures: unknown[] = []
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
        onRunFailed: (error) => reportedFailures.push(error),
      })

      expect(result.run.status).toBe("succeeded")
      expect(reportedFailures).toHaveLength(0)
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
    expect(result.run.output).toEqual(result.nodes[1]?.output)
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

  test("parks at an agent node and resumes from its validated structured output", async () => {
    const workflow = defineWorkflow("agent-resolves-invoice")
      .input({ transaction: ref(Transaction) })
      .then(resolveInvoiceWithAgent)
    const sixb = createSixb({ workflows: [workflow], agents: [invoiceResolverAgent] })
    const runtime = createRuntime(sixb)

    const waiting = await runWorkflowJob({
      runtime,
      job: {
        id: "wfrun_agent_resolution",
        workflowId: workflow.id,
        input: {
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      },
      observer: new EventsRuntimeWorkflowRunObserver(sixb.events),
    })

    expect(waiting.status).toBe("waiting")
    const node = waiting.nodes[0]
    expect(node).toMatchObject({ nodeType: "agent", status: "waiting" })
    const execution = await sixb.storage.workflowRuns!.agentNodes.getByNodeRunId({
      projectId: sixb.id,
      nodeRunId: node!.id,
    })
    expect(execution).toMatchObject({
      agentId: invoiceResolverAgent.id,
      status: "queued",
      prompt: "Resolve transaction 'txn_1'.",
    })
    const waitingEvents = await sixb.events.read({ topics: ["workflows"] })
    expect(waitingEvents.map((event) => event.type)).toEqual([
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.waiting",
      "workflow.run.waiting",
    ])
    expect(waitingEvents[2]?.payload).toMatchObject({
      workflowId: workflow.id,
      runId: waiting.id,
      nodeRunId: node!.id,
      nodeType: "agent",
    })
    const [queuedAgentJob] = await sixb.queues.agents.claim({
      projectId: sixb.id,
      workerId: "agent-test-worker",
    })
    expect(queuedAgentJob?.job).toMatchObject({
      type: "agent.workflow-node.requested",
      payload: { agentId: invoiceResolverAgent.id, nodeRunId: node!.id },
    })

    const token = "agent_execution_1"
    await sixb.storage.workflowRuns!.agentNodes.start({
      projectId: sixb.id,
      nodeRunId: node!.id,
      execution: {
        token,
        queueLeaseExpiresAt: new Date("2026-05-08T10:15:00.000Z"),
      },
    })
    const output = {
      invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
      confidence: 0.97,
      reason: "Matching amount and supplier.",
    } as const
    await sixb.storage.transaction(async (tx) => {
      await tx.workflowRuns!.agentNodes.finish({
        projectId: sixb.id,
        nodeRunId: node!.id,
        executionToken: token,
        status: "succeeded",
      })
      await tx.workflowRuns!.nodes.finish({
        projectId: sixb.id,
        id: node!.id,
        status: "succeeded",
        output,
      })
    })

    const resumed = await runWorkflowResumeJob({
      runtime,
      job: {
        id: waiting.id,
        workflowId: workflow.id,
        resume: { kind: "agentNode", nodeRunId: node!.id },
      },
    })
    expect(resumed.status).toBe("succeeded")
    expect(resumed.run.output).toEqual(output)
    expect(resumed.steps.resolveInvoiceWithAgent).toEqual(output)
  })

  test("notifies run waiting when a parked node notification fails", async () => {
    const workflow = defineWorkflow("agent-waiting-observer-fails")
      .input({ transaction: ref(Transaction) })
      .then(resolveInvoiceWithAgent)
    const sixb = createSixb({ workflows: [workflow], agents: [invoiceResolverAgent] })
    let runWaitingNotified = false
    const observer: WorkflowRunObserver = {
      onRunStarted: async () => undefined,
      onNodeStarted: async () => undefined,
      async onNodeWaiting() {
        throw new Error("node waiting observer failed")
      },
      async onRunWaiting() {
        runWaitingNotified = true
      },
      onNodeFinished: async () => undefined,
      onRunFinished: async () => undefined,
    }

    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_agent_waiting_observer_fails",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
        observer,
      })

      expect(result.status).toBe("waiting")
      expect(runWaitingNotified).toBe(true)
    } finally {
      console.error = originalConsoleError
    }
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
        resume: {
          kind: "intervention",
          interventionId: "wfrun_resume:intervention:1",
        },
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
    expect(run?.output).toEqual(nodes.nodes[2]?.output)
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
        resume: {
          kind: "intervention",
          interventionId: "wfrun_resume:intervention:1",
        },
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
          resume: {
            kind: "intervention",
            interventionId: "wfrun_invalid_resume_response:intervention:1",
          },
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

    await queueWorkflowRunFixture(sixb, {
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

  test("uses the workflow input as output when every node is an action", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("create-invoice-only-workflow")
      .input({ invoice: ref(Invoice) })
      .then(createInvoice)
    const sixb = createSixb({ actions: [createInvoice], workflows: [workflow] })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")
    const input = {
      invoice: { objectTypeId: "Invoice" as const, primaryId: "inv_1" },
    }

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_action_only",
          workflowId: workflow.id,
          input,
        },
      })

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]?.nodeType).toBe("action")
      expect(result.run.output).toEqual(input)
    } finally {
      unsubscribe()
    }
  })

  test("waits for action nodes to finish without running the action handler inline", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("attach-invoice-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        subject: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    await createTestSixb(sixb).objects.upsert("Transaction", { id: "txn_1" })
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
      expect(result.nodes[1]?.output).toEqual({
        actionRunId: "wfrun_action:action:1",
      })
      expect(result.run.output).toEqual(result.nodes[0]?.output)

      const actionRun = await sixb.storage.actionRuns?.getById({
        projectId: sixb.id,
        id: "wfrun_action:action:1",
      })
      expect(actionRun).not.toBeNull()
      const actionExecution = actionRun
        ? await sixb.storage.executions.getById({
            projectId: sixb.id,
            id: actionRun.executionId,
          })
        : null
      expect(actionExecution).toMatchObject({
        executor: { type: "primitive", kind: "action", runId: "wfrun_action:action:1" },
        source: { type: "execution", executionId: "direct-workflow-execution-test" },
        parentExecutionId: "direct-workflow-execution-test",
        correlationId: "direct-workflow-correlation-test",
        authorizationRef: {
          type: "trustedPrimitive",
          primitive: {
            kind: "action",
            id: "attach-invoice",
            runId: "wfrun_action:action:1",
          },
        },
      })
    } finally {
      unsubscribe()
    }
  })

  test("runs global action nodes through the canonical action runtime", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("create-invoice-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(createInvoice, ({ steps }) => ({
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const sixb = createSixb({ actions: [createInvoice], workflows: [workflow] })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_global_action",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await sixb.events.read({
        types: ["action.requested"],
      })
      expect(actionHandlerCalls).toBe(0)
      expect(events[0]?.payload).toMatchObject({
        subject: { kind: "none" },
        actionId: "create-invoice",
        runId: "wfrun_global_action:action:1",
      })
      expect(result.nodes[1]?.status).toBe("succeeded")
      expect(result.nodes[1]?.output).toEqual({
        actionRunId: "wfrun_global_action:action:1",
      })
    } finally {
      unsubscribe()
    }
  })

  test("runs global action nodes with direct dataflow", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("create-invoice-direct-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(createInvoice)
    const sixb = createSixb({ actions: [createInvoice], workflows: [workflow] })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_global_action_direct",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await sixb.events.read({
        types: ["action.requested"],
      })
      expect(actionHandlerCalls).toBe(0)
      expect(events[0]?.payload).toMatchObject({
        subject: { kind: "none" },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        },
        actionId: "create-invoice",
        runId: "wfrun_global_action_direct:action:1",
      })
      const params = events[0]?.type === "action.requested" ? events[0].payload.params : {}
      expect(params).not.toHaveProperty("transaction")
      expect(params).not.toHaveProperty("confidence")
      expect(result.nodes[1]?.input).toEqual({
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        },
      })
      expect(result.nodes[1]?.status).toBe("succeeded")
    } finally {
      unsubscribe()
    }
  })

  test("picks declared params from direct global action dataflow", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("create-invoice-from-transaction-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(prepareInvoice)
      .then(createInvoiceFromTransaction)
    const sixb = createSixb({
      actions: [createInvoiceFromTransaction],
      workflows: [workflow],
    })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_pick_global_action_params",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await sixb.events.read({
        types: ["action.requested"],
      })
      expect(events[0]?.payload).toMatchObject({
        subject: { kind: "none" },
        params: {
          amount: 250,
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
        actionId: "create-invoice-from-transaction",
        runId: "wfrun_pick_global_action_params:action:1",
      })
      const params = events[0]?.type === "action.requested" ? events[0].payload.params : {}
      expect(params).not.toHaveProperty("extraContext")
      expect(result.nodes[1]?.input).toEqual({
        params: {
          amount: 250,
          transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
        },
      })
      expect(result.nodes[1]?.status).toBe("succeeded")
    } finally {
      unsubscribe()
    }
  })

  test("runs object action nodes with direct dataflow", async () => {
    actionHandlerCalls = 0
    const workflow = defineWorkflow("attach-invoice-direct-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(prepareAttachInvoiceAction)
      .then(attachInvoice)
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    await createTestSixb(sixb).objects.upsert("Transaction", { id: "txn_1" })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded")

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_object_action_direct",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })

      const events = await sixb.events.read({
        types: ["action.requested"],
      })
      expect(actionHandlerCalls).toBe(0)
      expect(events[0]?.payload).toMatchObject({
        subject: {
          kind: "object",
          objectTypeId: "Transaction",
          primaryId: "txn_1",
        },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        },
        actionId: "attach-invoice",
        runId: "wfrun_object_action_direct:action:2",
      })
      const params = events[0]?.type === "action.requested" ? events[0].payload.params : {}
      expect(params).not.toHaveProperty("confidence")
      expect(result.nodes[2]?.input).toEqual({
        subject: {
          kind: "object",
          objectTypeId: "Transaction",
          primaryId: "txn_1",
        },
        params: {
          invoice: { objectTypeId: "Invoice", primaryId: "inv_1" },
        },
      })
      expect(result.nodes[2]?.status).toBe("succeeded")
    } finally {
      unsubscribe()
    }
  })

  test("succeeds action nodes when only action effects fail", async () => {
    const workflow = defineWorkflow("action-effects-fail-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        subject: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    const unsubscribe = await completeRequestedActions(sixb, "succeeded", "action failed", {
      effectsErrorMessage: "notification failed",
    })

    try {
      const result = await runWorkflowJob({
        runtime: createRuntime(sixb),
        job: {
          id: "wfrun_action_effects_failed",
          workflowId: workflow.id,
          input: {
            transaction: { objectTypeId: "Transaction", primaryId: "txn_1" },
          },
        },
      })
      const actionRun = await sixb.storage.actionRuns!.getById({
        projectId: sixb.id,
        id: "wfrun_action_effects_failed:action:1",
      })

      expect(result.run.status).toBe("succeeded")
      expect(result.nodes[1]?.status).toBe("succeeded")
      expect(actionRun?.status).toBe("succeeded")
      expect(actionRun?.effects).toMatchObject({
        status: "failed",
        error: { message: "notification failed", phase: "effects" },
      })
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
        subject: input.transaction,
        params: {
          invoice: steps.findBestInvoice.invoice,
        },
      }))
    const sixb = createSixb({ actions: [attachInvoice], workflows: [workflow] })
    await createTestSixb(sixb).objects.upsert("Transaction", { id: "txn_1" })
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

  test("marks action node and workflow failed when the action run fails after request", async () => {
    const workflow = defineWorkflow("missing-subject-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(findBestInvoice)
      .then(attachInvoice, ({ input, steps }) => ({
        subject: input.transaction,
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
