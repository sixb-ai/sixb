import { describe, expect, test } from "bun:test"
import { EventsRuntime, InMemoryBroker, toStoredEvent } from "../src"

describe("workflow runtime events", () => {
  test("stores workflow lifecycle events with workflow topic and run partition", () => {
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

    expect([started, nodeStarted, nodeFinished]).toEqual(
      expect.arrayContaining([
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
      },
    })
  })

  test("appends and reads workflow lifecycle events through the events runtime", async () => {
    const eventsRuntime = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
    })

    await eventsRuntime.append({
      events: [
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
          },
        },
      ],
    })

    const events = await eventsRuntime.read({
      topics: ["workflows"],
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
    expect(events[3]?.payload).toEqual({
      workflowId: "reconcile-transaction",
      runId: "wfrun_1",
      status: "failed",
    })
  })
})
