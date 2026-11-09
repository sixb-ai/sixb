import { describe, expect, test } from "bun:test"
import type { SixbFailure } from "../errors/types"
import type {
  ClaimRunInput,
  ConfirmRunExecutionInput,
  ListLostRunsInput,
  PipelineRunRecord,
  PipelineRunStorage,
  ReleaseRunExecutionInput,
  RunClaim,
  RunExecution,
  Storage,
  SyncRunRecord,
  SyncRunStorage,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "../storage"
import { ORPHANED_RUN_AFTER_MS, planRunClaim } from "../storage/run-claim"
import { queueTestPipelineRun } from "./pipeline-execution"
import { queueTestSyncRun } from "./sync-execution"
import { createTestWorkflowExecution } from "./workflow-execution"

export type RunClaimStorageContractStorage = Pick<
  Storage,
  "executions" | "syncRuns" | "pipelineRuns" | "workflowRuns" | "transaction"
>

export interface RunClaimStorageContractSuiteOptions<
  TStorage extends RunClaimStorageContractStorage,
> {
  /** Factory that returns one isolated store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** What an older version leaves behind: a run that holds no lease, as no API can write it. */
  readonly forgetExecution: (
    storage: TStorage,
    table: "sync_runs" | "pipeline_runs" | "workflow_runs",
    id: string
  ) => void | Promise<void>
}

const projectId = "run-claim-contract"
// In the future: whether a write with no token may pass reads the clock, and these leases are live.
const claimedAt = new Date("2100-06-01T12:00:00.000Z")
const later = new Date("2100-06-01T12:10:00.000Z")
const stillLater = new Date("2100-06-01T12:20:00.000Z")

const failure = {
  code: "internal.unexpected",
  message: "Failed.",
  retryable: false,
  at: "2026-06-01T12:00:00.000Z",
} as const satisfies SixbFailure<"internal.unexpected">

interface ClaimableRecord {
  readonly id: string
  readonly status: string
  readonly attempt: number
  readonly startedAt?: Date
  readonly execution?: RunExecution
}

/** The operations every recoverable run has, whichever store holds it. */
interface RunClaimContractPrimitive<TRun extends ClaimableRecord> {
  /** `sync` keeps a run of a Sync from waiting on another: only Syncs run one at a time. */
  queue(id: string, sync?: string): Promise<TRun>
  startOrReclaim(input: ClaimRunInput): Promise<RunClaim<TRun>>
  confirmExecutionOwnership(input: ConfirmRunExecutionInput): Promise<TRun>
  releaseExecution(input: ReleaseRunExecutionInput): Promise<void>
  listLost(input: Omit<ListLostRunsInput, "projectId">): Promise<readonly TRun[]>
  getById(params: { projectId: string; id: string }): Promise<TRun | null>
  succeed(id: string, executionToken?: string): Promise<TRun>
  cancel(id: string, executionToken?: string): Promise<TRun>
}

function syncPrimitive(
  storage: RunClaimStorageContractStorage
): RunClaimContractPrimitive<SyncRunRecord> {
  const runs = requireRuns(storage.syncRuns)

  return {
    queue: (id, sync = "orders") =>
      queueTestSyncRun(storage, {
        id,
        projectId,
        syncId: sync,
        datasetId: "orders",
        mode: "merge",
      }),
    startOrReclaim: (input) => runs.startOrReclaim(input),
    confirmExecutionOwnership: (input) => runs.confirmExecutionOwnership(input),
    releaseExecution: (input) => runs.releaseExecution(input),
    listLost: (input) => runs.listLost({ ...input, projectId }),
    getById: (params) => runs.getById(params),
    succeed: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "succeeded", rowsRead: 0 }),
    cancel: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "cancelled" }),
  }
}

function pipelinePrimitive(
  storage: RunClaimStorageContractStorage
): RunClaimContractPrimitive<PipelineRunRecord> {
  const runs = requireRuns(storage.pipelineRuns)

  return {
    queue: (id) => queueTestPipelineRun(storage, { id, projectId, pipelineId: "customers" }),
    startOrReclaim: (input) => runs.startOrReclaim(input),
    confirmExecutionOwnership: (input) => runs.confirmExecutionOwnership(input),
    releaseExecution: (input) => runs.releaseExecution(input),
    listLost: (input) => runs.listLost({ ...input, projectId }),
    getById: (params) => runs.getById(params),
    succeed: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "succeeded" }),
    cancel: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "cancelled" }),
  }
}

function workflowPrimitive(
  storage: RunClaimStorageContractStorage
): RunClaimContractPrimitive<WorkflowRunRecord> {
  const runs = requireRuns(storage.workflowRuns)

  return {
    async queue(id) {
      const executionId = await createTestWorkflowExecution(storage.executions, {
        projectId,
        workflowId: "review",
        runId: id,
      })
      return runs.queue({ id, projectId, executionId, workflowId: "review", input: {} })
    },
    startOrReclaim: (input) => runs.startOrReclaim(input),
    confirmExecutionOwnership: (input) => runs.confirmExecutionOwnership(input),
    releaseExecution: (input) => runs.releaseExecution(input),
    listLost: (input) => runs.listLost({ ...input, projectId }),
    getById: (params) => runs.getById(params),
    succeed: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "succeeded", output: {} }),
    cancel: (id, executionToken) =>
      runs.finish({ projectId, id, executionToken, status: "cancelled" }),
  }
}

function requireRuns<TRuns>(runs: TRuns | undefined): TRuns {
  if (!runs) throw new Error("Run storage is not configured for this suite.")
  return runs
}

function held(token: string, queueLeaseExpiresAt: Date = later): RunExecution {
  return { token, queueLeaseExpiresAt }
}

/** The contract every recoverable run keeps, whichever primitive it belongs to. */
export function runRunClaimStorageContractSuite<TStorage extends RunClaimStorageContractStorage>(
  label: string,
  options: RunClaimStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    describeClaims("Sync", withStorage, syncPrimitive, "sync_runs", options.forgetExecution)
    describeClaims(
      "Pipeline",
      withStorage,
      pipelinePrimitive,
      "pipeline_runs",
      options.forgetExecution
    )
    describeClaims(
      "Workflow",
      withStorage,
      workflowPrimitive,
      "workflow_runs",
      options.forgetExecution
    )

    test("Sync: a commit is prepared by the execution that holds the run, and survives it", async () => {
      await withStorage(async (storage) => {
        const runs = requireRuns(storage.syncRuns)
        const { queue } = syncPrimitive(storage)
        await queue("run")
        await runs.startOrReclaim({ projectId, id: "run", execution: held("first") })

        await runs.prepareCommit({
          projectId,
          id: "run",
          executionToken: "first",
          rowsRead: 3,
          checkpoint: { cursor: "c" },
          preparedAt: claimedAt,
        })

        await expect(runs.getById({ projectId, id: "run" })).resolves.toMatchObject({
          rowsRead: 3,
          checkpoint: { cursor: "c" },
          commitPreparedAt: claimedAt,
        })
        await expect(
          runs.prepareCommit({ projectId, id: "run", executionToken: "stale", rowsRead: 0 })
        ).rejects.toThrow("no longer current")
      })
    })

    test("Sync: one run of a Sync runs at a time", async () => {
      await withStorage(async (storage) => {
        const runs = requireRuns(storage.syncRuns)
        const { queue } = syncPrimitive(storage)
        await queue("first")
        await queue("second")

        await runs.startOrReclaim({ projectId, id: "first", execution: held("first"), claimedAt })

        const waiting = await runs.startOrReclaim({
          projectId,
          id: "second",
          execution: held("second"),
          claimedAt,
        })
        expect(waiting.outcome).toBe("waiting")
        expect(waiting.run.status).toBe("queued")

        // Handing a run back does not free the checkpoint: it is about to come back.
        await runs.releaseExecution({
          projectId,
          id: "first",
          executionToken: "first",
          spentAttempt: false,
          releasedAt: claimedAt,
        })
        await expect(
          runs.startOrReclaim({ projectId, id: "second", execution: held("second"), claimedAt })
        ).resolves.toMatchObject({ outcome: "waiting", sibling: { id: "first" } })

        await runs.startOrReclaim({ projectId, id: "first", execution: held("again"), claimedAt })
        await runs.finish({
          projectId,
          id: "first",
          executionToken: "again",
          status: "succeeded",
          rowsRead: 0,
        })

        await expect(
          runs.startOrReclaim({ projectId, id: "second", execution: held("second"), claimedAt })
        ).resolves.toMatchObject({ outcome: "started" })
      })
    })

    // Reproduce: count any running sibling in `planRunClaim`; the second run then waits for a day.
    test("Sync: a run of an older version holds no later run back", async () => {
      await withStorage(async (storage) => {
        const runs = requireRuns(storage.syncRuns)
        const { queue } = syncPrimitive(storage)
        await queue("old")
        await queue("new")

        await runs.startOrReclaim({ projectId, id: "old", execution: held("old"), claimedAt })
        await options.forgetExecution(storage, "sync_runs", "old")

        await expect(
          runs.startOrReclaim({ projectId, id: "new", execution: held("new"), claimedAt })
        ).resolves.toMatchObject({ outcome: "started" })
      })
    })

    test("Pipeline: only the execution that holds the run writes its steps", async () => {
      await withStorage(async (storage) => {
        const runs = requireRuns(storage.pipelineRuns)
        const { queue } = pipelinePrimitive(storage)
        await queue("run")
        await runs.startOrReclaim({ projectId, id: "run", execution: held("first") })

        const step = {
          projectId,
          id: "run:step:1:clean",
          pipelineRunId: "run",
          pipelineId: "customers",
          stepId: "clean",
          datasetId: "customers",
          mode: "append",
          inputs: [],
        } as const

        await expect(runs.startStep({ ...step, executionToken: "stale" })).rejects.toThrow(
          "no longer current"
        )

        await runs.startStep({ ...step, executionToken: "first" })

        await expect(
          runs.finishStep({
            projectId,
            id: step.id,
            executionToken: "stale",
            status: "failed",
          })
        ).rejects.toThrow("no longer current")
      })
    })

    test("Pipeline: a step left running starts over on new inputs, keeps its start, and a finished one does not", async () => {
      await withStorage(async (storage) => {
        const runs = requireRuns(storage.pipelineRuns)
        const { queue } = pipelinePrimitive(storage)
        await queue("run")
        await runs.startOrReclaim({
          projectId,
          id: "run",
          execution: held("first", claimedAt),
          claimedAt,
        })

        const step = {
          projectId,
          id: "run:step:1:clean",
          pipelineRunId: "run",
          pipelineId: "customers",
          stepId: "clean",
          datasetId: "customers",
          mode: "append",
        } as const
        const first = await runs.startStep({
          ...step,
          executionToken: "first",
          startedAt: claimedAt,
          inputs: [{ datasetId: "raw", versionId: "v1" }],
        })

        await runs.startOrReclaim({ projectId, id: "run", execution: held("second"), claimedAt })
        const restarted = await runs.startStep({
          ...step,
          executionToken: "second",
          inputs: [{ datasetId: "raw", versionId: "v2" }],
        })

        expect(restarted.inputs).toEqual([{ datasetId: "raw", versionId: "v2" }])
        expect(restarted.startedAt).toEqual(first.startedAt)
        const { steps } = await runs.listSteps({ projectId, pipelineRunId: "run" })
        expect(steps).toHaveLength(1)

        await runs.finishStep({
          projectId,
          id: step.id,
          executionToken: "second",
          status: "succeeded",
          output: { datasetId: "customers", versionId: "out" },
        })

        await expect(
          runs.startStep({ ...step, executionToken: "second", inputs: [] })
        ).rejects.toThrow("already exists")
      })
    })
  })
}

function describeClaims<
  TRun extends ClaimableRecord,
  TStorage extends RunClaimStorageContractStorage,
>(
  name: string,
  withStorage: (body: (storage: TStorage) => Promise<void>) => Promise<void>,
  primitiveOf: (storage: RunClaimStorageContractStorage) => RunClaimContractPrimitive<TRun>,
  table: "sync_runs" | "pipeline_runs" | "workflow_runs",
  forgetExecution: RunClaimStorageContractSuiteOptions<TStorage>["forgetExecution"]
): void {
  const withRun = (
    body: (primitive: RunClaimContractPrimitive<TRun>) => Promise<void>
  ): Promise<void> =>
    withStorage(async (storage) => {
      const primitive = primitiveOf(storage)
      await primitive.queue("run")
      await body(primitive)
    })

  test(`${name}: a queued run starts under the claiming execution`, async () => {
    await withRun(async (runs) => {
      const claim = await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("first"),
        claimedAt,
      })

      expect(claim).toMatchObject({
        outcome: "started",
        run: { status: "running", attempt: 1, startedAt: claimedAt },
      })
      expect(claim.run.execution).toEqual(held("first"))
    })
  })

  test(`${name}: a delivery finds a live execution's run held, and takes nothing`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      const duplicate = await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("second"),
        claimedAt,
      })

      expect(duplicate).toMatchObject({ outcome: "held", ownedUntil: later })
      const stored = await runs.getById({ projectId, id: "run" })
      expect(stored?.execution?.token).toBe("first")
      expect(stored?.attempt).toBe(1)
    })
  })

  test(`${name}: of two deliveries at once, one takes the run`, async () => {
    await withRun(async (runs) => {
      const claims = await Promise.all(
        ["first", "second"].map((token) =>
          runs.startOrReclaim({ projectId, id: "run", execution: held(token), claimedAt })
        )
      )

      expect(claims.map((claim) => claim.outcome).sort()).toEqual(["held", "started"])
    })
  })

  test(`${name}: a lapsed lease resumes under a new token and keeps the first start`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      const resumed = await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("second", stillLater),
        claimedAt: later,
      })

      expect(resumed).toMatchObject({
        outcome: "resumed",
        run: { status: "running", attempt: 2, startedAt: claimedAt },
      })
      expect(resumed.run.execution?.token).toBe("second")
    })
  })

  test(`${name}: a finished run settles every later delivery`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })
      await runs.succeed("run", "first")

      const late = await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("second"),
        claimedAt: stillLater,
      })

      expect(late).toMatchObject({ outcome: "settled", run: { status: "succeeded" } })
    })
  })

  // What each store's query says, one case per branch of it. The dates are in the far future so
  // that a run queued "now" counts as queued long before `queuedBefore`.
  const lostBy = {
    queuedBefore: stillLater,
    lapsedBy: later,
    orphanedBefore: new Date(claimedAt.getTime() + 1),
    limit: 10,
  }

  test(`${name}: nothing is lost while every run is held or has ended`, async () => {
    await withStorage(async (storage) => {
      const runs = primitiveOf(storage)
      await runs.queue("live", "live")
      await runs.queue("ended", "ended")
      await runs.startOrReclaim({
        projectId,
        id: "live",
        execution: held("a", stillLater),
        claimedAt,
      })
      await runs.startOrReclaim({ projectId, id: "ended", execution: held("b"), claimedAt })
      await runs.succeed("ended", "b")

      await expect(runs.listLost(lostBy)).resolves.toEqual([])
    })
  })

  test(`${name}: a queued run is lost past its grace, and not before`, async () => {
    await withRun(async (runs) => {
      const lost = await runs.listLost(lostBy)
      expect(lost.map((run) => run.id)).toEqual(["run"])

      const notYet = await runs.listLost({ ...lostBy, queuedBefore: new Date(0) })
      expect(notYet).toEqual([])
    })
  })

  test(`${name}: a run is lost once its lease lapsed, and a handed-back one with it`, async () => {
    await withStorage(async (storage) => {
      const runs = primitiveOf(storage)
      await runs.queue("lapsed", "lapsed")
      await runs.queue("handed-back", "handed-back")
      await runs.startOrReclaim({ projectId, id: "lapsed", execution: held("a", later), claimedAt })
      await runs.startOrReclaim({ projectId, id: "handed-back", execution: held("b"), claimedAt })
      await runs.releaseExecution({
        projectId,
        id: "handed-back",
        executionToken: "b",
        spentAttempt: false,
        releasedAt: claimedAt,
      })

      const lost = await runs.listLost(lostBy)
      expect(lost.map((run) => run.id)).toEqual(["handed-back", "lapsed"])
    })
  })

  test(`${name}: a run with no lease is lost only once its old worker cannot be alive`, async () => {
    await withStorage(async (storage) => {
      const runs = primitiveOf(storage)
      await runs.queue("old")
      await runs.startOrReclaim({ projectId, id: "old", execution: held("a"), claimedAt })
      await forgetExecution(storage, table, "old")

      await expect(
        runs.listLost({ ...lostBy, orphanedBefore: new Date(claimedAt.getTime() - 1) })
      ).resolves.toEqual([])

      const lost = await runs.listLost(lostBy)
      expect(lost.map((run) => run.id)).toEqual(["old"])
    })
  })

  // Sort by age alone to watch runs waiting for a sibling keep a lost run from ever being looked at.
  test(`${name}: running runs come first, however many queued ones are older`, async () => {
    await withStorage(async (storage) => {
      const runs = primitiveOf(storage)
      await runs.queue("waiting-1")
      await runs.queue("waiting-2")
      await runs.queue("lapsed")
      await runs.startOrReclaim({ projectId, id: "lapsed", execution: held("a", later), claimedAt })

      const lost = await runs.listLost({ ...lostBy, limit: 1 })
      expect(lost.map((run) => run.id)).toEqual(["lapsed"])
    })
  })

  test(`${name}: an old worker's run is left alone, then left to the recovery pass`, async () => {
    expect(
      planRunClaim(
        { id: "run", status: "running", attempt: 1, startedAt: claimedAt },
        { execution: held("new"), claimedAt: later }
      )
    ).toMatchObject({ take: false, claim: { outcome: "held" } })

    expect(
      planRunClaim(
        { id: "run", status: "running", attempt: 1, startedAt: claimedAt },
        {
          execution: held("new"),
          claimedAt: new Date(claimedAt.getTime() + ORPHANED_RUN_AFTER_MS),
        }
      )
    ).toMatchObject({ take: false, claim: { outcome: "settled" } })
  })

  test(`${name}: a stale token writes nothing`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })
      await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("second", stillLater),
        claimedAt: later,
      })

      await expect(runs.succeed("run", "first")).rejects.toThrow("no longer current")
      await expect(runs.succeed("run")).rejects.toThrow("no longer current")
      await expect(
        runs.confirmExecutionOwnership({
          projectId,
          id: "run",
          executionToken: "first",
          queueLeaseExpiresAt: stillLater,
        })
      ).rejects.toThrow("no longer current")
      await runs.releaseExecution({
        projectId,
        id: "run",
        executionToken: "first",
        spentAttempt: false,
      })

      const stored = await runs.getById({ projectId, id: "run" })
      expect(stored).toMatchObject({ status: "running", attempt: 2 })
      expect(stored?.execution?.token).toBe("second")
    })
  })

  test(`${name}: a renewal only moves the lease forward`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      const renew = (queueLeaseExpiresAt: Date) =>
        runs.confirmExecutionOwnership({
          projectId,
          id: "run",
          executionToken: "first",
          queueLeaseExpiresAt,
        })

      expect((await renew(stillLater)).execution?.queueLeaseExpiresAt).toEqual(stillLater)
      expect((await renew(later)).execution?.queueLeaseExpiresAt).toEqual(stillLater)
    })
  })

  test(`${name}: a stopped worker hands the run back at no cost`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      await runs.releaseExecution({
        projectId,
        id: "run",
        executionToken: "first",
        spentAttempt: false,
        releasedAt: claimedAt,
      })

      // The lease is over, and the next delivery does not wait for it.
      const released = await runs.getById({ projectId, id: "run" })
      expect(released).toMatchObject({ status: "running", attempt: 0 })
      expect(released?.execution?.queueLeaseExpiresAt).toEqual(claimedAt)

      await expect(
        runs.startOrReclaim({ projectId, id: "run", execution: held("second"), claimedAt })
      ).resolves.toMatchObject({ outcome: "resumed", run: { attempt: 1, startedAt: claimedAt } })
    })
  })

  test(`${name}: an attempt that failed stays spent when it hands the run back`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      await runs.releaseExecution({
        projectId,
        id: "run",
        executionToken: "first",
        spentAttempt: true,
        releasedAt: claimedAt,
      })

      await expect(
        runs.startOrReclaim({ projectId, id: "run", execution: held("second"), claimedAt })
      ).resolves.toMatchObject({ outcome: "resumed", run: { attempt: 2 } })
    })
  })

  // Accept the token-less case of `mayFinishRun` for any token to watch a stale run cancel its heir.
  test(`${name}: an execution that lost the run cannot cancel it either`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })
      await runs.startOrReclaim({
        projectId,
        id: "run",
        execution: held("second", stillLater),
        claimedAt: later,
      })

      await expect(runs.cancel("run", "first")).rejects.toThrow("no longer current")

      await expect(runs.getById({ projectId, id: "run" })).resolves.toMatchObject({
        status: "running",
      })
    })
  })

  test(`${name}: a cancel needs no token, and ends the run for whoever holds it`, async () => {
    await withRun(async (runs) => {
      await runs.startOrReclaim({ projectId, id: "run", execution: held("first"), claimedAt })

      await runs.cancel("run")

      await expect(runs.succeed("run", "first")).rejects.toThrow(/cannot (be )?finish/)
      await expect(
        runs.startOrReclaim({
          projectId,
          id: "run",
          execution: held("second"),
          claimedAt: stillLater,
        })
      ).resolves.toMatchObject({ outcome: "settled", run: { status: "cancelled" } })
    })
  })

  test(`${name}: a run that never started can be cancelled`, async () => {
    await withRun(async (runs) => {
      await runs.cancel("run")

      await expect(runs.getById({ projectId, id: "run" })).resolves.toMatchObject({
        status: "cancelled",
      })
    })
  })

  test(`${name}: a run that never started fails without a token`, async () => {
    await withStorage(async (storage) => {
      const primitive = primitiveOf(storage)
      await primitive.queue("queued")

      await failQueuedRun(storage, name, "queued")

      await expect(primitive.getById({ projectId, id: "queued" })).resolves.toMatchObject({
        status: "failed",
      })
    })
  })
}

function failQueuedRun(
  storage: RunClaimStorageContractStorage,
  name: string,
  id: string
): Promise<unknown> {
  const finish = { projectId, id, status: "failed", error: failure } as const

  if (name === "Sync") return (storage.syncRuns as SyncRunStorage).finish(finish)
  if (name === "Pipeline") return (storage.pipelineRuns as PipelineRunStorage).finish(finish)
  return (storage.workflowRuns as WorkflowRunStorage).finish(finish)
}
