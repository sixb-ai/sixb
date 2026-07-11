import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { WorkflowRunError } from "@sixb/core"
import type { PostgresStorage } from "../src"
import { PgWorkflowRunStorage } from "../src"
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
      error: "No invoice candidate",
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
    expect(failed?.error).toBe("No invoice candidate")
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
      error: "No match",
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
    expect(failedNodes.nodes[0]?.error).toBe("No match")
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
        error: "boom",
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
      error: "Stopped",
    })

    await expect(
      storage.workflowRuns.nodes.finish({
        id: "node-1",
        projectId: "my-app",
        status: "failed",
        error: "Too late",
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)

    await storage.workflowRuns.finish({
      id: "wf-run-1",
      projectId: "my-app",
      status: "cancelled",
      error: "Stopped",
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
        error: "Too late",
      })
    ).rejects.toBeInstanceOf(WorkflowRunError)
  })

  test("PostgresStorage includes workflow run storage", () => {
    expect(storage.workflowRuns).toBeInstanceOf(PgWorkflowRunStorage)
  })
})
