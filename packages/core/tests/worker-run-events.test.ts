import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { EventsRuntime, toStoredEvent } from "../src/events"

describe("worker run lifecycle events", () => {
  test("stores sync run lifecycle events with sync topic and run partition", () => {
    const started = toStoredEvent({
      projectId: "project-a",
      cursor: "1",
      event: {
        type: "sync.run.started",
        payload: {
          syncId: "sync-transactions",
          runId: "run-001",
          startedAt: "2026-05-08T10:00:00.000Z",
        },
      },
    })
    const finished = toStoredEvent({
      projectId: "project-a",
      cursor: "2",
      event: {
        type: "sync.run.finished",
        payload: {
          syncId: "sync-transactions",
          runId: "run-001",
          status: "succeeded",
          datasetId: "raw.transactions",
          versionId: "v1",
        },
      },
    })

    expect([started, finished]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "sync.run.started",
          topic: "syncs",
          partitionKey: "sync-transactions:run-001",
        }),
        expect.objectContaining({
          type: "sync.run.finished",
          topic: "syncs",
          partitionKey: "sync-transactions:run-001",
        }),
      ])
    )
  })

  test("appends and reads pipeline run lifecycle events in order", async () => {
    const eventsRuntime = new EventsRuntime({
      projectId: "project-a",
      broker: new InMemoryBroker(),
      host: null,
    })

    await eventsRuntime.append({
      events: [
        {
          type: "pipeline.run.started",
          payload: {
            pipelineId: "canonical-transactions",
            runId: "run-002",
            startedAt: "2026-05-08T10:00:00.000Z",
          },
        },
        {
          type: "pipeline.run.step.started",
          payload: {
            pipelineId: "canonical-transactions",
            runId: "run-002",
            stepRunId: "run-002:step:1:clean",
            stepId: "clean",
            stepIndex: 0,
            totalSteps: 1,
            datasetId: "canonical.transactions",
            startedAt: "2026-05-08T10:00:01.000Z",
          },
        },
        {
          type: "pipeline.run.step.finished",
          payload: {
            pipelineId: "canonical-transactions",
            runId: "run-002",
            stepRunId: "run-002:step:1:clean",
            stepId: "clean",
            stepIndex: 0,
            totalSteps: 1,
            datasetId: "canonical.transactions",
            status: "succeeded",
            finishedAt: "2026-05-08T10:00:02.000Z",
            versionId: "v2",
            rowsWritten: 10,
          },
        },
        {
          type: "pipeline.run.finished",
          payload: {
            pipelineId: "canonical-transactions",
            runId: "run-002",
            status: "succeeded",
            datasetId: "canonical.transactions",
            versionId: "v2",
          },
        },
      ],
    })

    const events = await eventsRuntime.read({
      topics: ["pipelines"],
    })

    expect(events.map((event) => event.type)).toEqual([
      "pipeline.run.started",
      "pipeline.run.step.started",
      "pipeline.run.step.finished",
      "pipeline.run.finished",
    ])
    expect(events.map((event) => event.partitionKey)).toEqual([
      "canonical-transactions:run-002",
      "canonical-transactions:run-002",
      "canonical-transactions:run-002",
      "canonical-transactions:run-002",
    ])
  })
})
