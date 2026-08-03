import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PostgresStorage } from "../src"
import { PgWorkflowRunStorage } from "../src/pg-workflow-run-storage"
import { createTestStorage } from "./helpers"

describe("PgWorkflowRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
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
      finishedAt: new Date("2026-05-08T10:00:04.500Z"),
    })

    const stored = await storage.workflowRuns.getById({
      projectId: "my-app",
      id: "wf-run-1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.error).toBeUndefined()
    expect(stored?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    })
    expect(stored?.startedAt.toISOString()).toBe("2026-05-08T10:00:00.000Z")
    expect(stored?.finishedAt?.toISOString()).toBe("2026-05-08T10:00:04.500Z")
  })

  test("persists workflow run source when starting directly or from a queued run", async () => {
    const scheduleSource = {
      type: "schedule",
      scheduleId: "invoice-payment-linked",
      eventId: "evt_1",
      principal: { type: "system", id: "sixb-orchestrator" },
    } as const

    const started = await storage.workflowRuns.start({
      id: "wf-run-triggered",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
      source: scheduleSource,
    })

    expect(started.source).toEqual(scheduleSource)
    expect(
      await storage.workflowRuns.getById({
        projectId: "my-app",
        id: "wf-run-triggered",
      })
    ).toMatchObject({ source: scheduleSource })

    await storage.workflowRuns.queue({
      id: "wf-run-queued-without-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
    })

    const running = await storage.workflowRuns.start({
      id: "wf-run-queued-without-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
      source: scheduleSource,
    })

    expect(running.source).toEqual(scheduleSource)

    await storage.workflowRuns.queue({
      id: "wf-run-queued-with-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_789" },
      source: { type: "manual" },
    })

    const alreadySourced = await storage.workflowRuns.start({
      id: "wf-run-queued-with-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_789" },
      source: scheduleSource,
    })

    expect(alreadySourced.source).toEqual({ type: "manual" })
  })

  test("allows exactly one concurrent claim of a queued workflow run", async () => {
    await storage.workflowRuns.queue({
      id: "wf-run-claim",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
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
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

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
      error: { code: "workflow.failed", message: "No invoice candidate" },
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
    expect(failed?.error).toEqual({ code: "workflow.failed", message: "No invoice candidate" })
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
      error: { code: "workflow.failed", message: "No match" },
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
    expect(failedNodes.nodes[0]?.error).toEqual({ code: "workflow.failed", message: "No match" })
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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await expect(
      storage.workflowRuns.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: { code: "workflow.failed", message: "boom" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_not_found")

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
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

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
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await storage.workflowRuns.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "cancelled",
      error: { code: "runtime.cancelled", message: "Stopped" },
    })

    await expect(
      storage.workflowRuns.nodes.finish({
        id: "node-1",
        projectId: "my-app",
        status: "failed",
        error: { code: "runtime.cancelled", message: "Too late" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await storage.workflowRuns.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "cancelled",
      error: { code: "runtime.cancelled", message: "Stopped" },
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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await expect(
      storage.workflowRuns.finish({
        id: "wf-run-1",
        projectId: "my-app",
        status: "failed",
        error: { code: "runtime.cancelled", message: "Too late" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")
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
    await storage.workflowRuns.agentNodes.create({
      projectId: "my-app",
      nodeRunId: "wf-run-agent:node:0",
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
      error: { code: "runtime.cancelled", message: "Workflow cancelled." },
    })
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error: { code: "runtime.cancelled", message: "Workflow cancelled." },
      prompt: "Resolve tr_1.",
    })
    expect(cancelled.execution).toBeUndefined()
  })

  test("PostgresStorage includes workflow run storage", () => {
    expect(storage.workflowRuns).toBeInstanceOf(PgWorkflowRunStorage)
  })
})
