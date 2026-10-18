import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService } from "../src/events"

const PIPELINE_STEP_FAILURE = {
  code: "internal.unexpected",
  retryable: false,
  message: "Pipeline step failed.",
  at: "2026-05-08T10:00:02.000Z",
  details: {
    pipelineId: "canonical-transactions",
    pipelineRunId: "run-002",
    stepId: "clean",
    stepRunId: "run-002:step:1:clean",
  },
} as const

const PIPELINE_RUN_FAILURE = {
  code: "internal.unexpected",
  retryable: false,
  message: "Pipeline run failed.",
  at: "2026-05-08T10:00:03.000Z",
  details: {
    pipelineId: "canonical-transactions",
    runId: "run-002",
  },
} as const

const SYNC_RUN_FAILURE = {
  code: "internal.unexpected",
  retryable: false,
  message: "Sync run failed.",
  at: "2026-05-08T10:00:03.000Z",
  details: {
    syncId: "sync-transactions",
    runId: "run-001",
  },
} as const

const STEP = {
  pipelineId: "canonical-transactions",
  runId: "run-002",
  stepRunId: "run-002:step:1:clean",
  stepId: "clean",
  stepIndex: 0,
  totalSteps: 1,
  datasetId: "canonical.transactions",
} as const

describe("worker run lifecycle events", () => {
  test("stores sync and pipeline run lifecycles in order on their topic and run partition", async () => {
    const eventsRuntime = new DomainEventService({
      projectId: "project-a",
      broker: new InMemoryBroker(),
    })

    await eventsRuntime.append({
      events: [
        {
          type: "sync.run.started",
          payload: {
            syncId: "sync-transactions",
            runId: "run-001",
            startedAt: "2026-05-08T10:00:00.000Z",
          },
        },
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
          payload: { ...STEP, startedAt: "2026-05-08T10:00:01.000Z" },
        },
        {
          type: "pipeline.run.step.finished",
          payload: {
            ...STEP,
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
        {
          type: "sync.run.finished",
          payload: {
            syncId: "sync-transactions",
            runId: "run-001",
            status: "succeeded",
            datasetId: "raw.transactions",
            versionId: "v1",
          },
        },
      ],
    })

    const pipelines = await eventsRuntime.read({ topics: ["pipelines"] })
    expect(pipelines.map((event) => [event.type, event.partitionKey])).toEqual([
      ["pipeline.run.started", "canonical-transactions:run-002"],
      ["pipeline.run.step.started", "canonical-transactions:run-002"],
      ["pipeline.run.step.finished", "canonical-transactions:run-002"],
      ["pipeline.run.finished", "canonical-transactions:run-002"],
    ])
    const syncs = await eventsRuntime.read({ topics: ["syncs"] })
    expect(syncs.map((event) => [event.type, event.partitionKey])).toEqual([
      ["sync.run.started", "sync-transactions:run-001"],
      ["sync.run.finished", "sync-transactions:run-001"],
    ])
  })

  test("preserves sync, pipeline step, and pipeline run failure records", async () => {
    const eventsRuntime = new DomainEventService({
      projectId: "project-a",
      broker: new InMemoryBroker(),
    })

    await eventsRuntime.append({
      events: [
        {
          type: "sync.run.finished",
          payload: {
            syncId: "sync-transactions",
            runId: "run-001",
            status: "failed",
            datasetId: "raw.transactions",
            error: SYNC_RUN_FAILURE,
          },
        },
        {
          type: "pipeline.run.step.finished",
          payload: {
            ...STEP,
            status: "failed",
            finishedAt: "2026-05-08T10:00:02.000Z",
            error: PIPELINE_STEP_FAILURE,
          },
        },
        {
          type: "pipeline.run.finished",
          payload: {
            pipelineId: "canonical-transactions",
            runId: "run-002",
            status: "failed",
            error: PIPELINE_RUN_FAILURE,
          },
        },
      ],
    })

    const errors = (await eventsRuntime.read()).map((event) =>
      "error" in event.payload ? event.payload.error : undefined
    )
    expect(errors).toEqual([SYNC_RUN_FAILURE, PIPELINE_STEP_FAILURE, PIPELINE_RUN_FAILURE])
  })
})
