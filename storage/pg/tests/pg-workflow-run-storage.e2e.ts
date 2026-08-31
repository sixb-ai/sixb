import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  type AgentRunFailureCode,
  type QueueWorkflowRunInput,
  type SixbFailure,
  type StartWorkflowRunInput,
  WorkflowRunError,
  type WorkflowRunFailureCode,
} from "@sixb/core/storage"
import {
  createTestAgentExecution,
  createTestAutomaticWorkflowExecution,
  createTestWorkflowExecution,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { PgWorkflowRunStorage } from "../src/pg-workflow-run-storage"
import { createTestStorage } from "./helpers"

function failure(
  message: string,
  code: WorkflowRunFailureCode = "internal.unexpected"
): SixbFailure<WorkflowRunFailureCode> {
  return {
    code,
    message,
    retryable: false,
    at: "2026-05-08T10:00:01.000Z",
    details: { workflowId: "reconcile-transaction" },
  }
}

function agentFailure(
  message: string,
  code: AgentRunFailureCode = "internal.unexpected"
): SixbFailure<AgentRunFailureCode> {
  return { code, message, retryable: false, at: "2026-05-08T10:00:01.000Z" }
}

describe("PgWorkflowRunStorage", () => {
  let root: PostgresStorage
  let storage: ReturnType<typeof createWorkflowRunStorage>

  beforeEach(async () => {
    ;({ storage: root } = await createTestStorage())
    storage = createWorkflowRunStorage(root)
  })

  afterEach(async () => {
    await root.dropSchema()
    await root.close()
  })

  test("starts and finishes workflow runs with JSON input", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {
        transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
      },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })

    const finished = await storage.workflowRuns.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "succeeded",
      output: { reconciled: true },
      finishedAt: new Date("2026-05-08T10:00:04.500Z"),
    })

    const stored = await storage.workflowRuns.getById({
      projectId: "my-app",
      id: "wf-run-1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.output).toEqual({ reconciled: true })
    expect(finished.error).toBeUndefined()
    expect(stored?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    })
    expect(stored?.startedAt.toISOString()).toBe("2026-05-08T10:00:00.000Z")
    expect(stored?.finishedAt?.toISOString()).toBe("2026-05-08T10:00:04.500Z")
  })

  test("requires a queued run linked to its matching workflow execution", async () => {
    await expect(
      root.workflowRuns.start({ id: "wf-run-missing", projectId: "my-app" })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    const executionId = await createTestWorkflowExecution(root.executions, {
      projectId: "my-app",
      workflowId: "other-workflow",
      runId: "wf-run-mismatched",
    })
    await expect(
      PgWorkflowRunStorage.prototype.queue.call(root.workflowRuns, {
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
      source: { type: "event", eventId: "source-event-1" },
    })
    await expect(
      PgWorkflowRunStorage.prototype.queue.call(root.workflowRuns, {
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
    await storage.workflowRuns.queue({
      id: "wf-run-claim",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
      requesterGroupIds: ["support", "engineering", "support"],
    })

    const results = await Promise.allSettled([
      storage.workflowRuns.start({
        id: "wf-run-claim",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      }),
      storage.workflowRuns.start({
        id: "wf-run-claim",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    await expect(
      storage.workflowRuns.getById({ projectId: "my-app", id: "wf-run-claim" })
    ).resolves.toMatchObject({ requesterGroupIds: ["engineering", "support"] })
  })

  test("waits and resumes workflow and intervention node runs", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-waiting",
      projectId: "my-app",
      workflowId: "review-workflow",
      input: { draftId: "draft-1" },
    })
    await storage.workflowRuns.nodes.start({
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

    const waitingNode = await storage.workflowRuns.nodes.wait({
      id: "node-waiting",
      projectId: "my-app",
    })
    const waitingRun = await storage.workflowRuns.wait({
      id: "wf-run-waiting",
      projectId: "my-app",
    })

    expect(waitingNode.status).toBe("waiting")
    expect(waitingRun.status).toBe("waiting")
    await expect(
      storage.workflowRuns.finish({
        id: "wf-run-waiting",
        projectId: "my-app",
        status: "succeeded",
        output: { decision: "approve" },
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    const resumedRun = await storage.workflowRuns.resume({
      id: "wf-run-waiting",
      projectId: "my-app",
    })
    const finishedNode = await storage.workflowRuns.nodes.finish({
      id: "node-waiting",
      projectId: "my-app",
      status: "succeeded",
      output: { decision: "approve" },
    })
    const finishedRun = await storage.workflowRuns.finish({
      id: "wf-run-waiting",
      projectId: "my-app",
      status: "succeeded",
      output: { decision: "approve" },
    })

    expect(resumedRun.status).toBe("running")
    expect(finishedNode.output).toEqual({ decision: "approve" })
    expect(finishedRun.status).toBe("succeeded")
  })

  test("stores failures and supports filtered workflow run paging", async () => {
    await storage.workflowRuns.start({
      id: "run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_1" },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.workflowRuns.finish({
      id: "run-1",
      projectId: "my-app",
      status: "failed",
      error: failure("No invoice candidate"),
    })

    await storage.workflowRuns.start({
      id: "run-2",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_2" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.workflowRuns.finish({
      id: "run-2",
      projectId: "my-app",
      status: "succeeded",
      output: { transactionId: "txn_2" },
    })

    await storage.workflowRuns.start({
      id: "run-3",
      projectId: "my-app",
      workflowId: "review-transaction",
      input: { transactionId: "txn_3" },
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const page = await storage.workflowRuns.list({
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

    const empty = await storage.workflowRuns.list({
      projectId: "my-app",
      statuses: [],
    })
    expect(empty).toEqual({
      runs: [],
      hasMore: false,
      total: 0,
    })

    const failed = await storage.workflowRuns.getById({
      projectId: "my-app",
      id: "run-1",
    })
    expect(failed?.error).toEqual(failure("No invoice candidate"))
  })

  test("lists the latest run for multiple workflow ids", async () => {
    await storage.workflowRuns.start({
      id: "run-reconcile-a",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_1" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.workflowRuns.start({
      id: "run-reconcile-z",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_2" },
      startedAt: new Date("2026-05-08T11:00:00.000Z"),
    })
    await storage.workflowRuns.start({
      id: "run-review",
      projectId: "my-app",
      workflowId: "review-transaction",
      input: { transactionId: "txn_3" },
      startedAt: new Date("2026-05-08T10:00:00.000Z"),
    })
    await storage.workflowRuns.start({
      id: "run-other-project",
      projectId: "other-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_4" },
      startedAt: new Date("2026-05-08T12:00:00.000Z"),
    })

    const latest = await storage.workflowRuns.listLatestByWorkflowIds({
      projectId: "my-app",
      workflowIds: ["review-transaction", "missing", "reconcile-transaction"],
    })

    expect(latest.runs.map((run) => run.id)).toEqual(["run-review", "run-reconcile-z"])
  })

  test("starts and finishes node runs with JSON input and output", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
    })

    await storage.workflowRuns.nodes.start({
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

    const finished = await storage.workflowRuns.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-05-08T10:00:01.200Z"),
      output: {
        invoiceId: "invoice_123",
        confidence: 0.98,
      },
    })

    const nodes = await storage.workflowRuns.nodes.list({
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

  test("stores failed node runs and supports filtered node paging", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
    })

    await storage.workflowRuns.nodes.start({
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
    await storage.workflowRuns.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "failed",
      error: failure("No match"),
    })

    await storage.workflowRuns.nodes.start({
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
    await storage.workflowRuns.nodes.finish({
      id: "node-2",
      projectId: "my-app",
      status: "succeeded",
      output: {},
    })

    await storage.workflowRuns.nodes.start({
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

    const page = await storage.workflowRuns.nodes.list({
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

    const failedNodes = await storage.workflowRuns.nodes.list({
      projectId: "my-app",
      statuses: ["failed"],
    })
    expect(failedNodes.nodes[0]?.output).toBeUndefined()
    expect(failedNodes.nodes[0]?.error).toEqual(failure("No match"))
  })

  test("rejects invalid workflow and node run lifecycle transitions", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-1",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
    })

    await expect(
      storage.workflowRuns.start({
        id: "wf-run-1",
        projectId: "my-app",
        workflowId: "reconcile-transaction",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.workflowRuns.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: failure("boom"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.workflowRuns.nodes.start({
        id: "bad-index",
        projectId: "my-app",
        workflowRunId: "wf-run-1",
        workflowId: "reconcile-transaction",
        nodeIndex: 1.5,
        nodeType: "step",
        nodeId: "bad-index",
        nodeKey: "bad-index",
        input: {},
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await expect(
      storage.workflowRuns.nodes.start({
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

    await storage.workflowRuns.nodes.start({
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
      storage.workflowRuns.nodes.start({
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

    await storage.workflowRuns.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "cancelled",
      error: failure("Stopped", "runtime.cancelled"),
    })

    await expect(
      storage.workflowRuns.nodes.finish({
        id: "node-1",
        projectId: "my-app",
        status: "failed",
        error: failure("Too late"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await storage.workflowRuns.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "cancelled",
      error: failure("Stopped", "runtime.cancelled"),
    })

    await expect(
      storage.workflowRuns.nodes.start({
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
      storage.workflowRuns.finish({
        id: "wf-run-1",
        projectId: "my-app",
        status: "failed",
        error: failure("Too late"),
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)
  })

  test("fences stale workflow deliveries after reclaim", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-fenced",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
      execution: {
        token: "workflow-exec-old",
        queueLeaseExpiresAt: new Date("2026-05-08T10:05:00.000Z"),
      },
    })
    await storage.workflowRuns.nodes.start({
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

    const reclaimed = await storage.workflowRuns.reclaim({
      id: "wf-run-fenced",
      projectId: "my-app",
      execution: {
        token: "workflow-exec-new",
        queueLeaseExpiresAt: new Date("2026-05-08T10:10:00.000Z"),
      },
    })
    expect(reclaimed.attempt).toBe(2)
    await expect(
      storage.workflowRuns.nodes.finish({
        id: "wf-run-fenced:node:0",
        projectId: "my-app",
        status: "succeeded",
        output: {},
        executionToken: "workflow-exec-old",
      })
    ).rejects.toThrow("Execution token is no longer current")
    await storage.workflowRuns.nodes.finish({
      id: "wf-run-fenced:node:0",
      projectId: "my-app",
      status: "succeeded",
      output: {},
      executionToken: "workflow-exec-new",
    })
  })

  test("stores and cancels agent workflow node execution metadata", async () => {
    await storage.workflowRuns.start({
      id: "wf-run-agent",
      projectId: "my-app",
      workflowId: "agent-workflow",
      input: {},
    })
    await storage.workflowRuns.nodes.start({
      id: "wf-run-agent:node:0",
      projectId: "my-app",
      workflowRunId: "wf-run-agent",
      workflowId: "agent-workflow",
      nodeIndex: 0,
      nodeType: "agent",
      nodeId: "resolver",
      nodeKey: "resolver",
      input: { transcriptId: "tr_1" },
    })
    const workflowRun = await storage.workflowRuns.getById({
      projectId: "my-app",
      id: "wf-run-agent",
    })
    if (!workflowRun) throw new Error("Expected workflow run.")
    const wrongExecutionId = await createTestAgentExecution(root, {
      projectId: "my-app",
      agentId: "resolver-agent",
      runId: "wf-run-agent:node:0",
      executionId: "test_agent_execution:wrong-parent",
      sourceExecutionId: "unrelated-workflow-execution",
    })
    await expect(
      storage.workflowRuns.agentNodes.create({
        projectId: "my-app",
        nodeRunId: "wf-run-agent:node:0",
        executionId: wrongExecutionId,
        agentId: "resolver-agent",
        prompt: "Resolve tr_1.",
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)
    const executionId = await createTestAgentExecution(root, {
      projectId: "my-app",
      agentId: "resolver-agent",
      runId: "wf-run-agent:node:0",
      sourceExecutionId: workflowRun.executionId,
    })
    await storage.workflowRuns.agentNodes.create({
      projectId: "my-app",
      nodeRunId: "wf-run-agent:node:0",
      executionId,
      agentId: "resolver-agent",
      prompt: "Resolve tr_1.",
    })
    const running = await storage.workflowRuns.agentNodes.start({
      projectId: "my-app",
      nodeRunId: "wf-run-agent:node:0",
      modelId: "test-model",
      execution: {
        token: "agent-exec-1",
        queueLeaseExpiresAt: new Date("2026-05-08T10:15:00.000Z"),
      },
    })
    expect(running).toMatchObject({ status: "running", attempt: 1, modelId: "test-model" })
    await expect(
      storage.workflowRuns.agentNodes.finish({
        projectId: "my-app",
        nodeRunId: running.nodeRunId,
        executionToken: "stale-agent-exec",
        status: "succeeded",
      })
    ).rejects.toThrow("Execution token is no longer current")

    const cancelled = await storage.workflowRuns.agentNodes.cancel({
      projectId: "my-app",
      nodeRunId: running.nodeRunId,
      error: agentFailure("Workflow cancelled.", "runtime.cancelled"),
    })
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error: agentFailure("Workflow cancelled.", "runtime.cancelled"),
      prompt: "Resolve tr_1.",
    })
    expect(cancelled.execution).toBeUndefined()
  })

  test("PostgresStorage includes workflow run storage", () => {
    expect(storage.workflowRuns).toBeInstanceOf(PgWorkflowRunStorage)
  })
})

type TestQueueWorkflowRunInput = Omit<QueueWorkflowRunInput, "executionId"> & {
  readonly executionId?: string
}

type TestStartWorkflowRunInput = StartWorkflowRunInput & {
  readonly workflowId?: string
  readonly input?: QueueWorkflowRunInput["input"]
}

function createWorkflowRunStorage(root: PostgresStorage) {
  const workflowRuns = root.workflowRuns
  const queue = workflowRuns.queue.bind(workflowRuns)
  const start = workflowRuns.start.bind(workflowRuns)
  const queueFixture = async (input: TestQueueWorkflowRunInput) => {
    const executionId = await createTestWorkflowExecution(root.executions, {
      projectId: input.projectId,
      workflowId: input.workflowId,
      runId: input.id,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    })
    return queue({ ...input, executionId })
  }
  const testWorkflowRuns = Object.assign(workflowRuns, {
    queue: queueFixture,
    start: async (input: TestStartWorkflowRunInput) => {
      const existing = await workflowRuns.getById({ projectId: input.projectId, id: input.id })
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
  return Object.assign(root, { workflowRuns: testWorkflowRuns })
}
