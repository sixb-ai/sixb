import { createHash } from "node:crypto"
import type { DatasetVersion, LakeStorage } from "../../lake-storage"
import type { PipelineRunDispatchPort } from "../../pipelines/run-dispatch"
import type { PipelineRunRecord, PipelineRunStorage, PipelineStepRunRecord } from "../../storage"
import type { MaintenancePass } from "../loop"
import type { LakeChangeFeed, LakeChangeReader } from "./lake-change-feed"
import { RECOVERY_INTERVAL_MS, recoveryPass } from "./recovery-pass"

const STEP_PAGE_SIZE = 500

/** How far back a dataset's versions are read to get past those that changed nothing. */
const CHANGE_LOOKBACK = 200

/** One pipeline runs when one dataset changes. */
export interface DatasetTrigger {
  readonly pipelineId: string
  readonly scheduleId: string
  readonly datasetId: string
}

export interface TriggersPassInput {
  readonly projectId: string
  readonly dispatcher: PipelineRunDispatchPort
  readonly triggers: readonly DatasetTrigger[]
  readonly feed: LakeChangeFeed
  readonly lakeStorage: Pick<LakeStorage, "getLatestVersion" | "listVersions">
  /** What each pipeline last read. */
  readonly pipelineRuns: Pick<PipelineRunStorage, "listLatestByPipelineIds" | "listSteps">
  readonly now?: () => number
}

/** The newest version that would have fired `updated()`, and every version from it to the latest. */
interface DatasetChange {
  readonly version: DatasetVersion
  readonly sameRows: ReadonlySet<string>
}

interface PipelineReads {
  /** The newest run, whatever became of it. */
  readonly latest: PipelineRunRecord
  /** The newest run that was not cancelled: what counts as having read. */
  readonly counted: PipelineRunRecord | undefined
  readonly stepsOfCounted: readonly PipelineStepRunRecord[]
}

/**
 * Recovers the `dataset.version.committed` a pipeline never heard about: the producer stopped
 * between its commit and the event, the broker refused or lost it, or no orchestrator ran.
 *
 * The event stays the fast path; this is the safety net, and it needs no record of its own. A
 * trigger counts as met when a dataset holds a change the pipeline's last run did not read:
 *
 * | Last run           | Then                                                         |
 * | ------------------ | ------------------------------------------------------------ |
 * | queued or running  | Look again next pass: it may have read before the change.    |
 * | failed             | What it read counts as read, so a failure is not retried.    |
 * | cancelled          | Does not count: the run before it decides.                   |
 * | none               | Nothing: a first run stays the user's or the next event's.   |
 *
 * A pass reads the change feed, which costs no pipeline anything when nothing moved. The triggers
 * of the datasets that moved stay unsettled until a run covers them. Every trigger starts unsettled,
 * so a restart needs no stored cursor.
 */
export function triggersPass(input: TriggersPassInput): MaintenancePass {
  const recovery = new TriggerRecovery(input)

  return recoveryPass("triggers", (signal) => recovery.run(signal))
}

class TriggerRecovery {
  private readonly triggersByDatasetId: ReadonlyMap<string, readonly DatasetTrigger[]>
  private readonly unsettled: Map<string, DatasetTrigger>
  private readonly changes: LakeChangeReader

  private readonly now: () => number

  constructor(private readonly input: TriggersPassInput) {
    this.now = input.now ?? Date.now
    this.triggersByDatasetId = groupByDataset(input.triggers)
    this.unsettled = new Map(input.triggers.map((trigger) => [triggerKey(trigger), trigger]))
    this.changes = input.feed.subscribe({
      datasetIds: this.triggersByDatasetId.keys(),
      onCursorLost: () => this.markUnsettled(input.triggers),
    })
  }

  async run(signal: AbortSignal): Promise<void> {
    // Read first: anything the checks below read after this is in the next read too.
    for (const { datasetId } of await this.changes.read()) {
      this.markUnsettled(this.triggersByDatasetId.get(datasetId) ?? [])
    }

    if (this.unsettled.size > 0) await this.settle(signal)
  }

  private markUnsettled(triggers: readonly DatasetTrigger[]): void {
    for (const trigger of triggers) this.unsettled.set(triggerKey(trigger), trigger)
  }

  private async settle(signal: AbortSignal): Promise<void> {
    const triggers = [...this.unsettled.values()]
    const reads = await this.readPipelines(triggers)
    const changes = await this.readChanges(triggers)

    const failures: Error[] = []
    for (const trigger of triggers) {
      signal.throwIfAborted()

      try {
        const settled = await this.settleTrigger(trigger, reads, changes)
        if (settled) this.unsettled.delete(triggerKey(trigger))
      } catch (error) {
        failures.push(dispatchFailure(trigger, error))
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, "[Sixb] The triggers pass failed.")
    }
  }

  /** Dispatches a trigger whose change no run covers. True when the trigger needs no more looks. */
  private async settleTrigger(
    trigger: DatasetTrigger,
    reads: ReadonlyMap<string, PipelineReads>,
    changes: ReadonlyMap<string, DatasetChange | null>
  ): Promise<boolean> {
    const pipeline = reads.get(trigger.pipelineId)
    if (!pipeline) return true

    const { latest, counted } = pipeline
    if (isActive(latest) || (counted && isActive(counted))) return false

    const change = changes.get(trigger.datasetId)
    if (!change) return true

    if (counted && hasRead(counted, pipeline.stepsOfCounted, trigger, change)) return true

    // Its event is most likely on its way: firing now would start a second run beside its own.
    if (this.now() - change.version.createdAt.getTime() < RECOVERY_INTERVAL_MS) return false

    // Unsettled still: the next pass sees this run, and a stop can cancel it.
    await this.dispatch(trigger, change.version, latest)
    return false
  }

  private async dispatch(
    trigger: DatasetTrigger,
    version: DatasetVersion,
    latest: PipelineRunRecord
  ): Promise<void> {
    const runId = recoveredRunId(trigger, version, latest)

    await this.input.dispatcher.dispatch({
      pipelineId: trigger.pipelineId,
      runId,
      source: {
        type: "datasetVersion",
        datasetId: version.datasetId,
        versionId: version.versionId,
      },
      correlationId: runId,
      metadata: {
        dispatchSource: "lake-reconciliation",
        scheduleId: trigger.scheduleId,
        datasetId: version.datasetId,
        versionId: version.versionId,
      },
    })
  }

  /** Batched per pipeline list, whatever the number of pipelines: the pass stays flat. */
  private async readPipelines(
    triggers: readonly DatasetTrigger[]
  ): Promise<ReadonlyMap<string, PipelineReads>> {
    const { projectId, pipelineRuns } = this.input
    const pipelineIds = [...new Set(triggers.map((trigger) => trigger.pipelineId))]

    const { runs: latest } = await pipelineRuns.listLatestByPipelineIds({ projectId, pipelineIds })
    const counted = await this.readCountedRuns(latest)
    const steps = await this.readSteps([...counted.values()])

    return new Map(
      latest.map((run) => {
        const countedRun = counted.get(run.pipelineId)
        const stepsOfCounted = countedRun ? (steps.get(countedRun.id) ?? []) : []
        return [run.pipelineId, { latest: run, counted: countedRun, stepsOfCounted }]
      })
    )
  }

  private async readCountedRuns(
    latest: readonly PipelineRunRecord[]
  ): Promise<ReadonlyMap<string, PipelineRunRecord>> {
    const cancelled = latest.filter((run) => run.status === "cancelled")
    const { runs: earlier } =
      cancelled.length === 0
        ? { runs: [] }
        : await this.input.pipelineRuns.listLatestByPipelineIds({
            projectId: this.input.projectId,
            pipelineIds: cancelled.map((run) => run.pipelineId),
            excludedStatus: "cancelled",
          })

    const counted = latest.filter((run) => run.status !== "cancelled")
    return new Map([...counted, ...earlier].map((run) => [run.pipelineId, run]))
  }

  private async readSteps(
    runs: readonly PipelineRunRecord[]
  ): Promise<ReadonlyMap<string, readonly PipelineStepRunRecord[]>> {
    const pipelineRunIds = runs.filter((run) => !isActive(run)).map((run) => run.id)
    const byRunId = new Map<string, PipelineStepRunRecord[]>()

    for (let offset = 0; pipelineRunIds.length > 0; offset += STEP_PAGE_SIZE) {
      const page = await this.input.pipelineRuns.listSteps({
        projectId: this.input.projectId,
        pipelineRunIds,
        limit: STEP_PAGE_SIZE,
        offset,
      })

      for (const step of page.steps) appendTo(byRunId, step.pipelineRunId, step)
      if (!page.hasMore) break
    }

    return byRunId
  }

  private async readChanges(
    triggers: readonly DatasetTrigger[]
  ): Promise<ReadonlyMap<string, DatasetChange | null>> {
    const datasetIds = [...new Set(triggers.map((trigger) => trigger.datasetId))]
    const changes = new Map<string, DatasetChange | null>()

    for (const datasetId of datasetIds) {
      changes.set(datasetId, await this.readChange(datasetId))
    }

    return changes
  }

  /**
   * The newest version alone cannot say: one that changed nothing may sit on a change whose event
   * was lost. So a version that would not fire `updated()` sends the read further back.
   */
  private async readChange(datasetId: string): Promise<DatasetChange | null> {
    const lake = this.input.lakeStorage

    const latest = await lake.getLatestVersion(datasetId)
    if (!latest) return null
    if (firesUpdated(latest)) return { version: latest, sameRows: new Set([latest.versionId]) }

    const sameRows = new Set<string>()
    for (const version of await lake.listVersions(datasetId, CHANGE_LOOKBACK)) {
      sameRows.add(version.versionId)
      if (firesUpdated(version)) return { version, sameRows }
    }
    return null
  }
}

/** As `events.dataset(x).updated()`: a data-bearing version that changed rows or lineage. */
function firesUpdated(version: DatasetVersion): boolean {
  return version.mode !== "schema" && (version.rowsChanged || version.lineageChanged)
}

function isActive(run: PipelineRunRecord): boolean {
  return run.status === "queued" || run.status === "running"
}

/**
 * Whether a run read `change` or something later. A step records what it read, and every step that
 * read the dataset must have seen the change: an earlier step on an older version computed from
 * stale rows. A run with no such step, because the dataset is no input of a step it reached, read
 * nothing of it: it covers the versions that existed when it started.
 */
function hasRead(
  run: PipelineRunRecord,
  steps: readonly PipelineStepRunRecord[],
  trigger: DatasetTrigger,
  change: DatasetChange
): boolean {
  const pins = steps.flatMap((step) =>
    step.inputs.filter((input) => input.datasetId === trigger.datasetId)
  )
  if (pins.length > 0) return pins.every((pin) => change.sameRows.has(pin.versionId))

  return change.version.createdAt <= (run.startedAt ?? run.queuedAt)
}

/**
 * The same change from the same state gives the same run, so two passes land on one. The latest run
 * is part of it because a cancelled run does not count: the id of a run that was cancelled must
 * not come back, or the dispatch would find it and do nothing.
 */
function recoveredRunId(
  trigger: DatasetTrigger,
  version: DatasetVersion,
  latest: PipelineRunRecord
): string {
  const after = createHash("sha256").update(`${version.versionId}\u0000${latest.id}`).digest("hex")
  return `pipeline:${trigger.pipelineId}:dataset:${trigger.datasetId}:recovered:${after}`
}

function dispatchFailure(trigger: DatasetTrigger, error: unknown): Error {
  return new Error(
    `[Sixb] The triggers pass could not dispatch (pipelineId=${trigger.pipelineId}, datasetId=${trigger.datasetId}).`,
    { cause: error }
  )
}

function groupByDataset(
  triggers: readonly DatasetTrigger[]
): ReadonlyMap<string, readonly DatasetTrigger[]> {
  const byDatasetId = new Map<string, DatasetTrigger[]>()

  for (const trigger of triggers) appendTo(byDatasetId, trigger.datasetId, trigger)

  return byDatasetId
}

function appendTo<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key)

  if (group) group.push(value)
  else groups.set(key, [value])
}

function triggerKey(trigger: DatasetTrigger): string {
  return `${trigger.pipelineId}\u0000${trigger.datasetId}`
}
