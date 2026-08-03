import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import { InMemoryWorkflowRunStorage } from "../src/storage"

describe("InMemoryWorkflowRunStorage", () => {
  test("starts and finishes a successful workflow run", async () => {
    const storage = new InMemoryWorkflowRunStorage()
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
      finishedAt,
    })

    const stored = await storage.getById({
      projectId: "my-app",
      id: "wf-run-1",
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.error).toBeUndefined()
    expect(stored?.input).toEqual({
      transaction: { objectTypeId: "Transaction", primaryId: "txn_123" },
    })
    expect(stored?.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(stored?.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("persists workflow run source when starting directly or from a queued run", async () => {
    const storage = new InMemoryWorkflowRunStorage()
    const scheduleSource = {
      type: "schedule",
      scheduleId: "invoice-payment-linked",
      eventId: "evt_1",
      principal: { type: "system", id: "sixb-orchestrator" },
    } as const

    const started = await storage.start({
      id: "wf-run-triggered",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
      source: scheduleSource,
    })

    expect(started.source).toEqual(scheduleSource)
    expect(
      await storage.getById({
        projectId: "my-app",
        id: "wf-run-triggered",
      })
    ).toMatchObject({ source: scheduleSource })

    await storage.queue({
      id: "wf-run-queued-without-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
    })

    const running = await storage.start({
      id: "wf-run-queued-without-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
      source: scheduleSource,
    })

    expect(running.source).toEqual(scheduleSource)

    await storage.queue({
      id: "wf-run-queued-with-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_789" },
      source: { type: "manual" },
    })

    const alreadySourced = await storage.start({
      id: "wf-run-queued-with-source",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_789" },
      source: scheduleSource,
    })

    expect(alreadySourced.source).toEqual({ type: "manual" })
  })

  test("allows exactly one concurrent claim of a queued workflow run", async () => {
    const storage = new InMemoryWorkflowRunStorage()
    await storage.queue({
      id: "wf-run-claim",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: {},
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
    const storage = new InMemoryWorkflowRunStorage()
    const queuedAt = new Date("2026-05-08T09:59:00.000Z")
    const startedAt = new Date("2026-05-08T10:00:00.000Z")

    const queued = await storage.queue({
      id: "wf-run-queued",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_123" },
      queuedAt,
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

    const failed = await storage.queue({
      id: "wf-run-failed-before-start",
      projectId: "my-app",
      workflowId: "reconcile-transaction",
      input: { transactionId: "txn_456" },
      queuedAt,
    })
    expect(failed.status).toBe("queued")

    const finished = await storage.finish({
      id: "wf-run-failed-before-start",
      projectId: "my-app",
      status: "failed",
      error: { code: "workflow.failed", message: "queue dispatch failed" },
    })
    expect(finished.status).toBe("failed")
    expect(finished.error).toEqual({ code: "workflow.failed", message: "queue dispatch failed" })
  })

  test("waits and resumes workflow and node runs", async () => {
    const storage = new InMemoryWorkflowRunStorage()

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
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

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
      error: { code: "runtime.cancelled", message: "Reviewer cancelled" },
    })
    expect(cancelled.status).toBe("cancelled")
  })

  test("stores failed workflow runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryWorkflowRunStorage()

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
      error: { code: "workflow.failed", message: "No invoice candidate" },
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
    expect(failed?.error).toEqual({ code: "workflow.failed", message: "No invoice candidate" })
  })

  test("lists the latest run for multiple workflow ids", async () => {
    const storage = new InMemoryWorkflowRunStorage()

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
    const storage = new InMemoryWorkflowRunStorage()

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
    const storage = new InMemoryWorkflowRunStorage()

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
      error: { code: "workflow.failed", message: "No match" },
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
    expect(failedNodes.nodes[0]?.error).toEqual({ code: "workflow.failed", message: "No match" })
  })

  test("rejects invalid workflow and node run lifecycle transitions", async () => {
    const storage = new InMemoryWorkflowRunStorage()

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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: { code: "workflow.failed", message: "boom" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_not_found")

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
    ).rejects.toHaveProperty("code", "workflow.run_not_found")

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
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

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
    ).rejects.toHaveProperty("code", "runtime.invalid_input")

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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await storage.nodes.finish({
      id: "node-1",
      projectId: "my-app",
      status: "cancelled",
      error: { code: "runtime.cancelled", message: "Stopped" },
    })

    await expect(
      storage.nodes.finish({
        id: "node-1",
        projectId: "my-app",
        status: "failed",
        error: { code: "runtime.cancelled", message: "Too late" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await storage.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "cancelled",
      error: { code: "runtime.cancelled", message: "Stopped" },
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
    ).rejects.toHaveProperty("code", "workflow.run_conflict")

    await expect(
      storage.finish({
        id: "wf-run-1",
        projectId: "my-app",
        status: "failed",
        error: { code: "runtime.cancelled", message: "Too late" },
      })
    ).rejects.toHaveProperty("code", "workflow.run_conflict")
  })

  test("InMemoryStorage includes workflow run storage", () => {
    const storage = new InMemoryStorage()
    expect(storage.workflowRuns).toBeInstanceOf(InMemoryWorkflowRunStorage)
  })

  test("fences stale workflow deliveries after reclaim", async () => {
    const storage = new InMemoryWorkflowRunStorage()
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
    const storage = new InMemoryWorkflowRunStorage()
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
    const execution = await storage.agentNodes.create({
      projectId: "my-app",
      nodeRunId: "wf-run-agent:node:0",
      agentId: "resolver",
      prompt: "Resolve txn_1.",
    })
    expect(execution).toMatchObject({ status: "queued", attempt: 0 })
    const cancelled = await storage.agentNodes.cancel({
      projectId: "my-app",
      nodeRunId: execution.nodeRunId,
      error: { code: "runtime.cancelled", message: "Workflow cancelled." },
    })
    expect(cancelled).toMatchObject({
      status: "cancelled",
      prompt: "Resolve txn_1.",
      error: { code: "runtime.cancelled", message: "Workflow cancelled." },
    })
    expect(
      (await storage.nodes.getById({ projectId: "my-app", id: execution.nodeRunId }))?.input
    ).toEqual({ transactionId: "txn_1" })
  })
})
