import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService, toStoredEvent } from "../src/events"

describe("workflow runtime events", () => {
  test("stores workflow lifecycle events with workflow topic and run partition", () => {
    const queued = toStoredEvent({
      projectId: "project-a",
      cursor: "0",
      event: {
        type: "workflow.run.queued",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          queuedAt: "2026-05-08T09:59:00.000Z",
          jobId: "job_1",
          source: { type: "manual" },
        },
      },
    })
    const started = toStoredEvent({
      projectId: "project-a",
      cursor: "1",
      event: {
        type: "workflow.run.started",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          startedAt: "2026-05-08T10:00:00.000Z",
        },
      },
    })
    const nodeStarted = toStoredEvent({
      projectId: "project-a",
      cursor: "2",
      event: {
        type: "workflow.run.node.started",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          nodeRunId: "wfrun_1:node:0",
          nodeIndex: 0,
          totalNodes: 1,
          nodeType: "step",
          nodeId: "find-best-invoice",
          nodeKey: "findBestInvoice",
          startedAt: "2026-05-08T10:00:01.000Z",
        },
      },
    })
    const nodeFinished = toStoredEvent({
      projectId: "project-a",
      cursor: "3",
      event: {
        type: "workflow.run.node.finished",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          nodeRunId: "wfrun_1:node:0",
          nodeIndex: 0,
          totalNodes: 1,
          nodeType: "step",
          nodeId: "find-best-invoice",
          nodeKey: "findBestInvoice",
          status: "succeeded",
          finishedAt: "2026-05-08T10:00:02.000Z",
        },
      },
    })

    expect([queued, started, nodeStarted, nodeFinished]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workflow.run.queued",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
        expect.objectContaining({
          type: "workflow.run.started",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
        expect.objectContaining({
          type: "workflow.run.node.started",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
        expect.objectContaining({
          type: "workflow.run.node.finished",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
      ])
    )
  })

  test("stores workflow.run.finished with workflow topic and run partition", () => {
    const event = toStoredEvent({
      projectId: "project-a",
      cursor: "1",
      event: {
        type: "workflow.run.finished",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          status: "succeeded",
          finishedAt: "2026-05-08T10:00:03.000Z",
        },
      },
    })

    expect(event).toMatchObject({
      type: "workflow.run.finished",
      topic: "workflows",
      partitionKey: "reconcile-transaction:wfrun_1",
      payload: {
        workflowId: "reconcile-transaction",
        runId: "wfrun_1",
        status: "succeeded",
        finishedAt: "2026-05-08T10:00:03.000Z",
      },
    })
  })

  test("stores workflow waiting and intervention events with workflow topic", () => {
    const waiting = toStoredEvent({
      projectId: "project-a",
      cursor: "1",
      event: {
        type: "workflow.run.waiting",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          waitingAt: "2026-05-08T10:00:03.000Z",
        },
      },
    })
    const requested = toStoredEvent({
      projectId: "project-a",
      cursor: "2",
      event: {
        type: "workflow.intervention.requested",
        payload: {
          workflowId: "reconcile-transaction",
          runId: "wfrun_1",
          nodeRunId: "wfrun_1:node:1",
          interventionId: "review-draft",
          pendingInterventionId: "wfi_1",
          requestedAt: "2026-05-08T10:00:03.000Z",
        },
      },
    })

    expect([waiting, requested]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "workflow.run.waiting",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
        expect.objectContaining({
          type: "workflow.intervention.requested",
          topic: "workflows",
          partitionKey: "reconcile-transaction:wfrun_1",
        }),
      ])
    )
  })

  test("appends and reads workflow lifecycle events through the events runtime", async () => {
    const eventsRuntime = new DomainEventService({
      projectId: "project-a",
      broker: new InMemoryBroker(),
    })

    await eventsRuntime.append({
      events: [
        {
          type: "workflow.run.queued",
          payload: {
            workflowId: "reconcile-transaction",
            runId: "wfrun_1",
            queuedAt: "2026-05-08T09:59:00.000Z",
          },
        },
        {
          type: "workflow.run.started",
          payload: {
            workflowId: "reconcile-transaction",
            runId: "wfrun_1",
            startedAt: "2026-05-08T10:00:00.000Z",
          },
        },
        {
          type: "workflow.run.node.started",
          payload: {
            workflowId: "reconcile-transaction",
            runId: "wfrun_1",
            nodeRunId: "wfrun_1:node:0",
            nodeIndex: 0,
            totalNodes: 1,
            nodeType: "step",
            nodeId: "find-best-invoice",
            nodeKey: "findBestInvoice",
            startedAt: "2026-05-08T10:00:01.000Z",
          },
        },
        {
          type: "workflow.run.node.finished",
          payload: {
            workflowId: "reconcile-transaction",
            runId: "wfrun_1",
            nodeRunId: "wfrun_1:node:0",
            nodeIndex: 0,
            totalNodes: 1,
            nodeType: "step",
            nodeId: "find-best-invoice",
            nodeKey: "findBestInvoice",
            status: "failed",
            finishedAt: "2026-05-08T10:00:02.000Z",
            error: "No match",
          },
        },
        {
          type: "workflow.run.finished",
          payload: {
            workflowId: "reconcile-transaction",
            runId: "wfrun_1",
            status: "failed",
            finishedAt: "2026-05-08T10:00:03.000Z",
            error: "No match",
          },
        },
      ],
    })

    const events = await eventsRuntime.read({
      topics: ["workflows"],
      types: [
        "workflow.run.queued",
        "workflow.run.started",
        "workflow.run.node.started",
        "workflow.run.node.finished",
        "workflow.run.finished",
      ],
    })

    expect(events.map((event) => event.type)).toEqual([
      "workflow.run.queued",
      "workflow.run.started",
      "workflow.run.node.started",
      "workflow.run.node.finished",
      "workflow.run.finished",
    ])
    expect(events[4]?.payload).toEqual({
      workflowId: "reconcile-transaction",
      runId: "wfrun_1",
      status: "failed",
      finishedAt: "2026-05-08T10:00:03.000Z",
      error: "No match",
    })
  })
})
