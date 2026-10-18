import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService } from "../src/events"

const WORKFLOW_FAILURE = {
  code: "internal.unexpected",
  retryable: false,
  message: "No match",
  at: "2026-05-08T10:00:02.000Z",
  details: {
    workflowId: "reconcile-transaction",
    runId: "wfrun_1",
  },
} as const

const RUN = { workflowId: "reconcile-transaction", runId: "wfrun_1" } as const

const NODE = {
  ...RUN,
  nodeRunId: "wfrun_1:node:0",
  nodeIndex: 0,
  totalNodes: 1,
  nodeType: "step",
  nodeId: "find-best-invoice",
  nodeKey: "findBestInvoice",
} as const

describe("workflow runtime events", () => {
  test("stores workflow lifecycle events under the workflow topic and run partition", async () => {
    const eventsRuntime = new DomainEventService({
      projectId: "project-a",
      broker: new InMemoryBroker(),
    })

    await eventsRuntime.append({
      events: [
        {
          type: "workflow.run.queued",
          payload: {
            ...RUN,
            queuedAt: "2026-05-08T09:59:00.000Z",
            jobId: "job_1",
            source: { type: "manual" },
          },
        },
        {
          type: "workflow.run.started",
          payload: { ...RUN, startedAt: "2026-05-08T10:00:00.000Z" },
        },
        {
          type: "workflow.run.node.started",
          payload: { ...NODE, startedAt: "2026-05-08T10:00:01.000Z" },
        },
        {
          type: "workflow.run.waiting",
          payload: { ...RUN, waitingAt: "2026-05-08T10:00:01.500Z" },
        },
        {
          type: "workflow.intervention.requested",
          payload: {
            ...RUN,
            nodeRunId: "wfrun_1:node:0",
            interventionId: "review-draft",
            pendingInterventionId: "wfi_1",
            requestedAt: "2026-05-08T10:00:01.500Z",
          },
        },
        {
          type: "workflow.run.node.finished",
          payload: {
            ...NODE,
            status: "failed",
            finishedAt: "2026-05-08T10:00:02.000Z",
            error: WORKFLOW_FAILURE,
          },
        },
        {
          type: "workflow.run.finished",
          payload: {
            ...RUN,
            status: "failed",
            finishedAt: "2026-05-08T10:00:03.000Z",
            error: WORKFLOW_FAILURE,
          },
        },
      ],
    })

    const events = await eventsRuntime.read({ topics: ["workflows"] })

    expect(events.map((event) => [event.type, event.topic, event.partitionKey])).toEqual(
      [
        "workflow.run.queued",
        "workflow.run.started",
        "workflow.run.node.started",
        "workflow.run.waiting",
        "workflow.intervention.requested",
        "workflow.run.node.finished",
        "workflow.run.finished",
      ].map((type) => [type, "workflows", "reconcile-transaction:wfrun_1"])
    )
    expect(events[6]?.payload).toEqual({
      ...RUN,
      status: "failed",
      finishedAt: "2026-05-08T10:00:03.000Z",
      error: WORKFLOW_FAILURE,
    })
    expect(events[5]?.payload).toMatchObject({ error: WORKFLOW_FAILURE })
  })
})
