import { describe, expect, test } from "bun:test"
import { InMemoryQueues, InMemoryStorage } from "../src"
import type { EventsAppendInput } from "../src/events/service"
import { ORPHANED_RUN_AFTER_MS } from "../src/storage/run-claim"
import { claimTestRun, queueTestPipelineRun } from "../src/testing"
import { queueTestSyncRun } from "../src/testing/sync-execution"
import { republishLostRuns } from "../src/workers/lost-runs"

const projectId = "lost-runs"
const longAgo = new Date("2026-11-01T00:00:00.000Z")
const now = new Date("2026-11-01T01:00:00.000Z")

function createFixture() {
  const storage = new InMemoryStorage()
  const queues = new InMemoryQueues()
  const emitted: EventsAppendInput["events"][number][] = []
  const events = {
    async emit(input: EventsAppendInput) {
      emitted.push(...input.events)
    },
  }

  return {
    storage,
    queues,
    emitted,
    pass: (limit?: number) => republishLostRuns({ projectId, storage, queues, events, now, limit }),
    queueSync: (id: string, queuedAt = longAgo) =>
      queueTestSyncRun(storage, {
        id,
        projectId,
        syncId: `sync-of-${id}`,
        datasetId: "orders",
        mode: "append",
        queuedAt,
      }),
    queuePipeline: (id: string, queuedAt = longAgo) =>
      queueTestPipelineRun(storage, { id, projectId, pipelineId: "customers", queuedAt }),
    claimSyncJobs: () => queues.syncRuns.claim({ projectId, workerId: "test", limit: 10 }),
    claimPipelineJobs: () => queues.pipelines.claim({ projectId, workerId: "test", limit: 10 }),
  }
}

describe("republishLostRuns", () => {
  test("publishes a job for queued runs of both lanes, and only for those past the grace", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-lost")
    await fixture.queueSync("sync-just-queued", new Date(now.getTime() - 1_000))
    await fixture.queuePipeline("pipeline-lost")

    await expect(fixture.pass()).resolves.toEqual({ republished: 2, settled: 0 })

    const [syncJob] = await fixture.claimSyncJobs()
    expect(syncJob?.job).toMatchObject({
      id: "sync-lost",
      type: "sync.run.requested",
      payload: { runId: "sync-lost" },
    })
    const [pipelineJob] = await fixture.claimPipelineJobs()
    expect(pipelineJob?.job).toMatchObject({
      id: "pipeline-lost",
      type: "pipeline.run.requested",
      payload: { runId: "pipeline-lost" },
    })
  })

  // A job still in the queue must absorb this one: republishing is what makes it safe to repeat.
  test("publishes one job however many passes see the run", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-lost")

    await fixture.pass()
    await fixture.pass()

    await expect(fixture.claimSyncJobs()).resolves.toHaveLength(1)
  })

  // Reuse the run's own job id here to watch this fail: the provider keeps the settled id.
  test("brings a new job to a running run whose lease lapsed, and none to a live one", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-lapsed")
    await fixture.queueSync("sync-live")

    const lease = (at: Date) => ({ token: `token:${at.getTime()}`, queueLeaseExpiresAt: at })
    await fixture.storage.syncRuns.startOrReclaim({
      projectId,
      id: "sync-lapsed",
      execution: lease(new Date(now.getTime() - 1)),
      claimedAt: longAgo,
    })
    await fixture.storage.syncRuns.startOrReclaim({
      projectId,
      id: "sync-live",
      execution: lease(new Date(now.getTime() + 60_000)),
      claimedAt: longAgo,
    })

    await expect(fixture.pass()).resolves.toEqual({ republished: 1, settled: 0 })

    const [job] = await fixture.claimSyncJobs()
    expect(job?.job).toMatchObject({
      id: "sync-lapsed:recover:1",
      payload: { runId: "sync-lapsed" },
    })
  })

  test("looks at no more than its limit per lane, oldest first", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-newer", new Date(longAgo.getTime() + 1_000))
    await fixture.queueSync("sync-oldest")

    await expect(fixture.pass(1)).resolves.toEqual({ republished: 1, settled: 0 })

    const [job] = await fixture.claimSyncJobs()
    expect(job?.job.id).toBe("sync-oldest")
  })

  test("a lane that fails does not hold the other, and still reaches the caller", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-lost")
    await fixture.queuePipeline("pipeline-lost")
    fixture.queues.syncRuns.enqueue = () => Promise.reject(new Error("sync queue unavailable"))

    await expect(fixture.pass()).rejects.toThrow("sync queue unavailable")

    await expect(fixture.claimPipelineJobs()).resolves.toHaveLength(1)
  })

  // Lets a run be lost for good: its job never came back, and nothing else would notice.
  test("brings a job to a run that was handed back", async () => {
    const fixture = createFixture()
    await fixture.queueSync("sync-handed-back")

    const claim = await claimTestRun(fixture.storage.syncRuns, {
      projectId,
      id: "sync-handed-back",
    })
    await fixture.storage.syncRuns.releaseExecution({
      projectId,
      id: "sync-handed-back",
      executionToken: claim.execution.token,
      spentAttempt: true,
      releasedAt: longAgo,
    })

    await expect(fixture.pass()).resolves.toEqual({ republished: 1, settled: 0 })
  })

  // What an older version leaves: `running`, with neither lease nor hand-back.
  async function leaveRunningWithoutLease(
    fixture: ReturnType<typeof createFixture>,
    startedAt: Date
  ) {
    await fixture.queueSync("sync-old")
    await fixture.queuePipeline("pipeline-old")
    await fixture.storage.syncRuns.startOrReclaim({
      projectId,
      id: "sync-old",
      execution: { token: "old", queueLeaseExpiresAt: new Date(0) },
      claimedAt: startedAt,
    })
    await fixture.storage.pipelineRuns.startOrReclaim({
      projectId,
      id: "pipeline-old",
      execution: { token: "old", queueLeaseExpiresAt: new Date(0) },
      claimedAt: startedAt,
    })
    await fixture.storage.pipelineRuns.startStep({
      projectId,
      id: "pipeline-old:step:1:clean",
      executionToken: "old",
      pipelineRunId: "pipeline-old",
      pipelineId: "customers",
      stepId: "clean",
      datasetId: "customers",
      mode: "append",
      inputs: [],
    })

    const syncs = fixture.storage.syncRuns as unknown as ForgetsExecution
    const pipelines = fixture.storage.pipelineRuns as unknown as ForgetsExecution
    syncs.rows.set(`${projectId}:sync-old`, {
      ...syncs.rows.get(`${projectId}:sync-old`),
      execution: undefined,
    })
    pipelines.runs.set(`${projectId}:pipeline-old`, {
      ...pipelines.runs.get(`${projectId}:pipeline-old`),
      execution: undefined,
    })
  }

  // Treat every run with no lease as lost to watch a rolling deploy cancel a live run.
  test("leaves a run of an older version alone while its worker may still be alive", async () => {
    const fixture = createFixture()
    await leaveRunningWithoutLease(fixture, new Date(now.getTime() - ORPHANED_RUN_AFTER_MS + 1))

    await expect(fixture.pass()).resolves.toEqual({ republished: 0, settled: 0 })

    await expect(
      fixture.storage.syncRuns.startOrReclaim({
        projectId,
        id: "sync-old",
        execution: { token: "new", queueLeaseExpiresAt: new Date(now.getTime() + 60_000) },
        claimedAt: now,
      })
    ).resolves.toMatchObject({ outcome: "held" })

    await expect(
      fixture.storage.syncRuns.finish({
        projectId,
        id: "sync-old",
        status: "succeeded",
        rowsRead: 0,
      })
    ).resolves.toMatchObject({ status: "succeeded" })
  })

  // Drop the settling from `recoverLane` to watch the trigger pass wait on this run for good.
  test("ends a run of an older version once its worker cannot still be alive", async () => {
    const fixture = createFixture()
    await leaveRunningWithoutLease(fixture, new Date(now.getTime() - ORPHANED_RUN_AFTER_MS))

    await expect(fixture.pass()).resolves.toEqual({ republished: 0, settled: 2 })

    await expect(
      fixture.storage.syncRuns.getById({ projectId, id: "sync-old" })
    ).resolves.toMatchObject({
      status: "cancelled",
      error: { code: "runtime.cancelled", message: expect.stringContaining("worker") },
    })

    const { steps } = await fixture.storage.pipelineRuns.listSteps({
      projectId,
      pipelineRunId: "pipeline-old",
    })
    expect(steps.map((step) => step.status)).toEqual(["cancelled"])

    expect(fixture.emitted.map((event) => event.type).sort()).toEqual([
      "pipeline.run.finished",
      "sync.run.finished",
    ])
  })
})

/** The in-memory stores' rows, reached to leave what only an older version could write. */
interface ForgetsExecution {
  readonly rows: Map<string, object>
  readonly runs: Map<string, object>
}
