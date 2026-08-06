import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import {
  type AgentRunFailureCode,
  InMemoryWorkflowRunStorage,
  type QueueWorkflowRunInput,
  type SixbFailure,
  type StartWorkflowRunInput,
  WorkflowRunError,
  type WorkflowRunFailureCode,
} from "../src/storage"
import {
  createTestAgentExecution,
  createTestAutomaticWorkflowExecution,
  createTestWorkflowExecution,
} from "../src/testing"

type TestQueueWorkflowRunInput = Omit<QueueWorkflowRunInput, "executionId"> & {
  readonly executionId?: string
}

type TestStartWorkflowRunInput = StartWorkflowRunInput & {
  readonly workflowId?: string
  readonly input?: QueueWorkflowRunInput["input"]
}

function createWorkflowRunStorage() {
  const root = new InMemoryStorage()
  const storage = root.workflowRuns!
  const queue = storage.queue.bind(storage)
  const start = storage.start.bind(storage)
  const queueFixture = async (input: TestQueueWorkflowRunInput) => {
    const executionId = await createTestWorkflowExecution(root.executions, {
      projectId: input.projectId,
      workflowId: input.workflowId,
      runId: input.id,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    })
    return queue({ ...input, executionId })
  }

  return Object.assign(storage, {
    root,
    queue: queueFixture,
    start: async (input: TestStartWorkflowRunInput) => {
      const existing = await storage.getById({ projectId: input.projectId, id: input.id })
      if (!existing && input.workflowId && input.input) {
        await queueFixture({
          id: input.id,
          projectId: input.projectId,
          workflowId: input.workflowId,
          input: input.input,
          requesterGroupIds: [],
        })
      }
      return start({
        id: input.id,
        projectId: input.projectId,
        ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
        ...(input.execution === undefined ? {} : { execution: input.execution }),
      })
    },
  })
}

const FAILURE_AT = "2026-05-08T10:00:00.000Z"

function failure(
  message: string,
  code: WorkflowRunFailureCode = "internal.unexpected"
): SixbFailure<WorkflowRunFailureCode> {
  return { code, message, retryable: false, at: FAILURE_AT }
}

function agentFailure(
  message: string,
  code: AgentRunFailureCode = "internal.unexpected"
): SixbFailure<AgentRunFailureCode> {
  return { code, message, retryable: false, at: FAILURE_AT }
}

describe("InMemoryWorkflowRunStorage", () => {
  test("starts and finishes a successful workflow run", async () => {
    const storage = createWorkflowRunStorage()
    const startedAt = new Date("2026-05-08T10:00:00.000Z")
    const finishedAt = new Date("2026-05-08T10:00:04.500Z")

    const started = await storage.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
      },
      startedAt,
    })

    ;(started.input as { transaction: { primaryId: string } }).transaction.primaryId = "mutated"

    const finished = await storage.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "succeeded",
      output: { reconciled: true },
      finishedAt,
    })

    const stored = await storage.getById({
      projectId: "my-app",
      id: "wf-run-1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.output).toEqual({ reconciled: true })
    expect(finished.error).toBeUndefined()
    expect(stored?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    })
    expect(stored?.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(stored?.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("requires a queued run linked to its matching workflow execution", async () => {
    const root = new InMemoryStorage()
    const storage = root.workflowRuns!

    await expect(
      storage.start({ id: "wf-run-missing", projectId: "my-app" })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await root.executions.create({
      id: "orphan-workflow-execution",
      projectId: "my-app",
      executor: { type: "primitive", kind: "workflow", runId: "wf-run-orphan" },
      source: { type: "http", requestId: "request-without-parent" },
      correlationId: "orphan-correlation",
      authorizationRef: {
        type: "trustedPrimitive",
        primitive: {
          kind: "workflow",
          id: "reconcile-transaction",
          runId: "wf-run-orphan",
        },
      },
    })
    await expect(
      storage.queue({
        id: "wf-run-orphan",
        projectId: "my-app",
        executionId: "orphan-workflow-execution",
        workflowId: "reconcile-transaction",
        input: {},
        requesterGroupIds: [],
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    const executionId = await createTestWorkflowExecution(root.executions, {
      projectId: "my-app",
      workflowId: "other-workflow",
      runId: "wf-run-mismatched",
    })
    await expect(
      storage.queue({
        id: "wf-run-mismatched",
        projectId: "my-app",
        executionId,
        workflowId: "reconcile-transaction",
        input: {},
        requesterGroupIds: [],
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    const automaticExecutionId = await createTestAutomaticWorkflowExecution(root.executions, {
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      runId: "wf-run-automatic",
      source: { type: "schedule", eventId: "schedule-event-1" },
    })
    await expect(
      storage.queue({
        id: "wf-run-automatic",
        projectId: "my-app",
        executionId: automaticExecutionId,
        workflowId: "reconcile-transaction",
        input: {},
        requesterGroupIds: [],
      })
    ).resolves.toMatchObject({ id: "wf-run-automatic", executionId: automaticExecutionId })
  })

  test("allows exactly one concurrent claim of a queued workflow run", async () => {
    const storage = createWorkflowRunStorage()
    await storage.queue({
      id: "wf-run-claim",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
      requesterGroupIds: [],
    })

    const results = await Promise.allSettled([
      storage.start({
        id: "wf-run-claim",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      }),
      storage.start({
        id: "wf-run-claim",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  test("queues workflow runs before transitioning them to running", async () => {
    const storage = createWorkflowRunStorage()
    const queuedAt = new Date("2026-05-08T09:59:00.000Z")
    const startedAt = new Date("2026-05-08T10:00:00.000Z")

    const queued = await storage.queue({
      id: "wf-run-queued",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
      queuedAt,
      requesterGroupIds: ["support", "engineering", "support"],
    })

    const running = await storage.start({
      id: "wf-run-queued",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
      startedAt,
    })

    expect(queued.status).toBe("queued")
    expect(queued.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
    expect(running.status).toBe("running")
    expect(running.queuedAt?.toISOString()).toBe(queuedAt.toISOString())
    expect(running.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(running.requesterGroupIds).toEqual(["engineering", "support"])

    const failed = await storage.queue({
      id: "wf-run-failed-before-start",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
      queuedAt,
      requesterGroupIds: [],
    })
    expect(failed.status).toBe("queued")

    const finished = await storage.finish({
      id: "wf-run-failed-before-start",
      projectId: "my-app",
      status: "failed",
      error: failure("queue dispatch failed"),
    })
    expect(finished.status).toBe("failed")
    expect(finished.error).toEqual(failure("queue dispatch failed"))
  })

  test("waits and resumes workflow and node runs", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "wf-run-waiting",
      projectId: "my-app",
      workflowId: "review-workflow",
      input: { draftId: "draft-1" },
    })
    await storage.nodes.start({
      id: "node-waiting",
      projectId: "my-app",
      workflowRunId: "wf-run-waiting",
      workflowId: "review-workflow",
      nodeIndex: 0,
      nodeType: "intervention",
      nodeId: "review-draft",
      nodeKey: "reviewDraft",
      input: { draftId: "draft-1" },
    })

    const waitingNode = await storage.nodes.wait({
      id: "node-waiting",
      projectId: "my-app",
    })
    const waitingRun = await storage.wait({
      id: "wf-run-waiting",
      projectId: "my-app",
    })

    expect(waitingNode.status).toBe("waiting")
    expect(waitingRun.status).toBe("waiting")
    await expect(
      storage.finish({
        id: "wf-run-waiting",
        projectId: "my-app",
        status: "succeeded",
        output: { decision: "approve" },
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    const resumedRun = await storage.resume({
      id: "wf-run-waiting",
      projectId: "my-app",
    })
    const finishedNode = await storage.nodes.finish({
      id: "node-waiting",
      projectId: "my-app",
      status: "succeeded",
      output: { decision: "approve" },
    })
    const finishedRun = await storage.finish({
      id: "wf-run-waiting",
      projectId: "my-app",
      status: "succeeded",
      output: { decision: "approve" },
    })

    expect(resumedRun.status).toBe("running")
    expect(finishedNode.output).toEqual({ decision: "approve" })
    expect(finishedRun.status).toBe("succeeded")

    await storage.start({
      id: "wf-run-cancelled-while-waiting",
      projectId: "my-app",
      workflowId: "review-workflow",
      input: {},
    })
    await storage.wait({
      id: "wf-run-cancelled-while-waiting",
      projectId: "my-app",
    })

    const cancelled = await storage.finish({
      id: "wf-run-cancelled-while-waiting",
      projectId: "my-app",
      status: "cancelled",
      error: failure("Reviewer cancelled", "runtime.cancelled"),
    })
    expect(cancelled.status).toBe("cancelled")
  })

  test("stores failed workflow runs and lists with filters, ordering, and paging", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_1" },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      error: failure("No invoice candidate"),
    })

    await storage.start({
      id: "run-2",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_2" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      output: { transactionId: "txn_2" },
    })

    await storage.start({
      id: "run-3",
      projectId: "my-app",
      workflowId: "review-transaction",
      input: { transactionId: "txn_3" },
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-05-08T10:30:00.000Z"),
      limit: 1,
      offset: 0,
    })

    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["run-2"])

    const empty = await storage.list({
      projectId: "my-app",
      statuses: [],
    })
    expect(empty).toEqual({
      runs: [],
      hasMore: false,
      total: 0,
    })

    const failed = await storage.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toEqual(failure("No invoice candidate"))
  })

  test("lists the latest run for multiple workflow ids", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "run-reconcile-a",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_1" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.start({
      id: "run-reconcile-z",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_2" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.start({
      id: "run-review",
      projectId: "my-app",
      workflowId: "review-transaction",
      input: { transactionId: "txn_3" },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.start({
      id: "run-other-project",
      projectId: "other-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_4" },
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const latest = await storage.listLatestByWorkflowIds({
      projectId: "my-app",
      workflowIds: ["review-transaction", "missing", "reconcile-transaction"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["run-review", "run-reconcile-z"])
  })

  test("starts and finishes node runs with pinned input and output", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
    })

    const started = await storage.nodes.start({
      id: "node-1",
      projectId: "my-app",
      workflowRunId: "wf-run-1",
      workflowId: "reconcile-transaction",
      nodeIndex: 0,
      nodeType: "step",
      nodeId: "find-best-invoice",
      nodeKey: "find-best-invoice",
      input: { transactionId: "txn_123" },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })

    ;(started.input as { transactionId: string }).transactionId = "mutated"

    const finished = await storage.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-05-08T10:00:01.200Z"),
      output: {
        invoiceId: "invoice_123",
        confidence: 0.98,
      },
    })

    const nodes = await storage.nodes.list({
      projectId: "my-app",
      workflowRunId: "wf-run-1",
    })

    expect(finished).toMatchObject({
      status: "succeeded",
      input: {
        transactionId: "txn_123",
      },
      output: {
        invoiceId: "invoice_123",
        confidence: 0.98,
      },
    })
    expect(nodes.total).toBe(1)
    expect(nodes.nodes.map((node) => node.id)).toEqual(["node-1"])
  })

  test("stores failed node runs and lists with filters, ordering, and paging", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
    })

    await storage.nodes.start({
      id: "node-1",
      projectId: "my-app",
      workflowRunId: "wf-run-1",
      workflowId: "reconcile-transaction",
      nodeIndex: 0,
      nodeType: "step",
      nodeId: "find-best-invoice",
      nodeKey: "find-best-invoice",
      input: {},
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "failed",
      error: failure("No match"),
    })

    await storage.nodes.start({
      id: "node-2",
      projectId: "my-app",
      workflowRunId: "wf-run-1",
      workflowId: "reconcile-transaction",
      nodeIndex: 1,
      nodeType: "action",
      nodeId: "request-review",
      nodeKey: "request-review",
      input: {},
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.nodes.finish({
      id: "node-2",
      projectId: "my-app",
      status: "succeeded",
      output: {},
    })

    await storage.nodes.start({
      id: "node-3",
      projectId: "my-app",
      workflowRunId: "wf-run-1",
      workflowId: "reconcile-transaction",
      nodeIndex: 2,
      nodeType: "step",
      nodeId: "summarize",
      nodeKey: "summarize",
      input: {},
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const page = await storage.nodes.list({
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      statuses: ["running", "succeeded"],
      startedAfter: new Date("2026-05-08T10:30:00.000Z"),
      limit: 1,
      offset: 1,
    })

    expect(page.total).toBe(2)
    expect(page.hasMore).toBe(false)
    expect(page.nodes.map((node) => node.id)).toEqual(["node-2"])

    const failedNodes = await storage.nodes.list({
      projectId: "my-app",
      statuses: ["failed"],
    })
    expect(failedNodes.nodes[0]?.output).toBeUndefined()
    expect(failedNodes.nodes[0]?.error).toEqual(failure("No match"))
  })

  test("rejects invalid workflow and node run lifecycle transitions", async () => {
    const storage = createWorkflowRunStorage()

    await storage.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
    })

    await expect(
      storage.start({
        id: "wf-run-1",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: failure("boom"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.nodes.start({
        id: "bad-node",
        projectId: "my-app",
        workflowRunId: "missing",
        workflowId: "reconcile-transaction",
        nodeIndex: 0,
        nodeType: "step",
        nodeId: "missing-parent",
        nodeKey: "missing-parent",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.nodes.start({
        id: "bad-index",
        projectId: "my-app",
        workflowRunId: "wf-run-1",
        workflowId: "reconcile-transaction",
        nodeIndex: -1,
        nodeType: "step",
        nodeId: "bad-index",
        nodeKey: "bad-index",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.nodes.start({
        id: "wrong-workflow",
        projectId: "my-app",
        workflowRunId: "wf-run-1",
        workflowId: "other-workflow",
        nodeIndex: 0,
        nodeType: "step",
        nodeId: "wrong-workflow",
        nodeKey: "wrong-workflow",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await storage.nodes.start({
      id: "node-1",
      projectId: "my-app",
      workflowRunId: "wf-run-1",
      workflowId: "reconcile-transaction",
      nodeIndex: 0,
      nodeType: "step",
      nodeId: "find-best-invoice",
      nodeKey: "find-best-invoice",
      input: {},
    })

    await expect(
      storage.nodes.start({
        id: "node-1",
        projectId: "my-app",
        workflowRunId: "wf-run-1",
        workflowId: "reconcile-transaction",
        nodeIndex: 1,
        nodeType: "step",
        nodeId: "duplicate",
        nodeKey: "duplicate",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await storage.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "cancelled",
      error: failure("Stopped", "runtime.cancelled"),
    })

    await expect(
      storage.nodes.finish({
        id: "node-1",
        projectId: "my-app",
        status: "failed",
        error: failure("Too late"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await storage.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "cancelled",
      error: failure("Stopped", "runtime.cancelled"),
    })

    await expect(
      storage.nodes.start({
        id: "too-late",
        projectId: "my-app",
        workflowRunId: "wf-run-1",
        workflowId: "reconcile-transaction",
        nodeIndex: 2,
        nodeType: "step",
        nodeId: "too-late",
        nodeKey: "too-late",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.finish({
        id: "wf-run-1",
        projectId: "my-app",
        status: "failed",
        error: failure("Too late"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)
  })

  test("InMemoryStorage includes workflow run storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.workflowRuns).toBeInstanceOf(InMemoryWorkflowRunStorage)
  })

  test("fences stale workflow deliveries after reclaim", async () => {
    const storage = createWorkflowRunStorage()
    await storage.start({
      id: "wf-run-unowned",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
    })
    await expect(
      storage.confirmExecutionOwnership({
        id: "wf-run-unowned",
        projectId: "my-app",
        executionToken: "workflow-exec-invented",
        queueLeaseExpiresAt: new Date("2026-05-08T10:05:00.000Z"),
      })
    ).rejects.toThrow("Execution token is no longer current")

    await storage.start({
      id: "wf-run-fenced",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
      execution: {
        token: "workflow-exec-old",
        queueLeaseExpiresAt: new Date("2026-05-08T10:05:00.000Z"),
      },
    })
    await storage.nodes.start({
      id: "wf-run-fenced:node:0",
      projectId: "my-app",
      workflowRunId: "wf-run-fenced",
      workflowId: "reconcile-transaction",
      nodeIndex: 0,
      nodeType: "step",
      nodeId: "resolve",
      nodeKey: "resolve",
      input: {},
      executionToken: "workflow-exec-old",
    })

    const reclaimed = await storage.reclaim({
      id: "wf-run-fenced",
      projectId: "my-app",
      execution: {
        token: "workflow-exec-new",
        queueLeaseExpiresAt: new Date("2026-05-08T10:10:00.000Z"),
      },
    })
    expect(reclaimed.attempt).toBe(2)
    await expect(
      storage.nodes.finish({
        id: "wf-run-fenced:node:0",
        projectId: "my-app",
        status: "succeeded",
        output: {},
        executionToken: "workflow-exec-old",
      })
    ).rejects.toThrow("Execution token is no longer current")
    await storage.nodes.finish({
      id: "wf-run-fenced:node:0",
      projectId: "my-app",
      status: "succeeded",
      output: {},
      executionToken: "workflow-exec-new",
    })
  })

  test("persists and cancels agent node execution metadata independently from node IO", async () => {
    const storage = createWorkflowRunStorage()
    await storage.start({
      id: "wf-run-agent",
      projectId: "my-app",
      workflowId: "resolve-transaction",
      input: {},
    })
    await storage.nodes.start({
      id: "wf-run-agent:node:0",
      projectId: "my-app",
      workflowRunId: "wf-run-agent",
      workflowId: "resolve-transaction",
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: "resolve-agent",
      nodeKey: "resolveAgent",
      input: { transactionId: "txn_1" },
    })
    const workflowRun = await storage.getById({ projectId: "my-app", id: "wf-run-agent" })
    if (!workflowRun) throw new Error("Expected workflow run.")
    const wrongExecutionId = await createTestAgentExecution(storage.root, {
      projectId: "my-app",
      agentId: "resolver",
      runId: "wf-run-agent:node:0",
      executionId: "test_agent_execution:wrong-parent",
      parentExecutionId: "unrelated-workflow-execution",
    })
    await expect(
      storage.agentNodes.create({
        projectId: "my-app",
        nodeRunId: "wf-run-agent:node:0",
        executionId: wrongExecutionId,
        agentId: "resolver",
        prompt: "Resolve txn_1.",
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)
    const executionId = await createTestAgentExecution(storage.root, {
      projectId: "my-app",
      agentId: "resolver",
      runId: "wf-run-agent:node:0",
      parentExecutionId: workflowRun.executionId,
    })
    const execution = await storage.agentNodes.create({
      projectId: "my-app",
      nodeRunId: "wf-run-agent:node:0",
      executionId,
      agentId: "resolver",
      prompt: "Resolve txn_1.",
    })
    expect(execution).toMatchObject({ status: "queued", attempt: 0 })
    const cancelled = await storage.agentNodes.cancel({
      projectId: "my-app",
      nodeRunId: execution.nodeRunId,
      error: agentFailure("Workflow cancelled.", "runtime.cancelled"),
    })
    expect(cancelled).toMatchObject({
      status: "cancelled",
      prompt: "Resolve txn_1.",
      error: agentFailure("Workflow cancelled.", "runtime.cancelled"),
    })
    expect(
      (await storage.nodes.getById({ projectId: "my-app", id: execution.nodeRunId }))?.input
    ).toEqual({ transactionId: "txn_1" })
  })
})
