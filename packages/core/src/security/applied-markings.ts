import type { LakeStorage } from "../lake-storage/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import type { OntologySourceStorage } from "../storage/ontology"
import {
  type AppliedVersionRead,
  appliedContribution,
  errorMessage,
  producingPipelines,
  type SourceProjection,
  sentence,
} from "./applied-markings-contribution"
import {
  type AppliedContribution,
  type AppliedMarkingsSnapshot,
  assembleAppliedMarkings,
  NO_APPLIED_MARKINGS,
  NO_CONTRIBUTION,
} from "./applied-markings-snapshot"
import type { DatasetVersionMarkings } from "./dataset-version-markings"

/**
 * Objects keep the markings of the dataset version they were projected from.
 *
 * Startup checks the code: each projected property declares the markings its column carries. The
 * objects a projection applied may predate that code. When a property stops declaring a marking
 * its applied version still carries on the column, the objects still hold those values. Until the
 * projection applies a version the code allows, each such property keeps the marking (its
 * surplus), and an object type or link whose key column carries markings is unreadable to readers
 * lacking them, like a type they have no view grant for.
 *
 * Lifecycle:
 * - The first read that needs the snapshot reads it, with one storage query for the projections'
 *   active sources; only projections whose applied version or definition changed are classified
 *   again. A project whose columns carry no marking reads nothing.
 * - A timer then refreshes it every few seconds, while reads keep needing it. A host no read has
 *   needed for a while stops refreshing, and the next read refreshes first. The timer never keeps
 *   a process alive.
 * - A host that applies a projection invalidates the snapshot, so its next read refreshes first:
 *   `sixb dev` sees a version at once, other servers within the interval.
 * - A refresh that fails keeps the last snapshot for twice the interval; past that age, and past
 *   the same deadline for a refresh that hangs, reads fail.
 */
export interface AppliedMarkings {
  /** Whether readers with these clearances can be denied anything the code alone allows. */
  affects(clearances: ReadonlySet<string>): boolean
  /** The current snapshot; reads it on first use and when it is older than the bound. */
  current(): Promise<AppliedMarkingsSnapshot>
  /** A projection applied a version in this process: the next read refreshes first. */
  invalidate(): void
  /** Stop refreshing in the background. The next read that needs the snapshot starts again. */
  stopRefreshing(): void
  /** Change the refresh interval, for this repo's tests. */
  setRefreshInterval(intervalMs: number): void
}

export interface AppliedMarkingsOptions {
  readonly projectId: string
  readonly ontology: Pick<OntologyDefinitionCatalog, "getObjectTypeById">
  readonly projections: Pick<ProjectionDefinitionCatalog, "listObjects" | "listLinks">
  /** The revision of a projection's current definition. */
  readonly revisionOf: (projectionId: string) => string
  readonly pipelines: readonly PipelineDefinition[]
  readonly versionMarkings: DatasetVersionMarkings
  readonly lakeStorage: Pick<LakeStorage, "getVersion">
  readonly sources: Pick<OntologySourceStorage, "listActive">
  readonly refreshIntervalMs?: number
  /** A monotonic clock in milliseconds. */
  readonly now?: () => number
  /** Runs `tick` every `intervalMs` without keeping the process alive. Tests drive it by hand. */
  readonly schedule?: (tick: () => void, intervalMs: number) => () => void
}

export const APPLIED_MARKINGS_REFRESH_MS = 5_000
/** Refreshes a host runs without any read needing the snapshot before it stops refreshing. */
const IDLE_REFRESHES = 12

interface ProjectionState {
  /** The applied version and revision the contribution was computed for. */
  readonly key: string
  /** The version could not be read: seal now, read it again on the next refresh. */
  readonly retry: boolean
  readonly contribution: AppliedContribution
}

export function createAppliedMarkings(options: AppliedMarkingsOptions): AppliedMarkings {
  let intervalMs = options.refreshIntervalMs ?? APPLIED_MARKINGS_REFRESH_MS
  // Past this age a read waits for a refresh, and fails if it fails; a refresh fails past it too.
  const maxAgeMs = () => 2 * intervalMs
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? scheduleUnref
  const versionMarkings = options.versionMarkings
  let pipelineOf: ((datasetId: string) => string | undefined) | undefined

  let snapshot: AppliedMarkingsSnapshot | undefined
  let fingerprint: string | undefined
  let refreshedAt = 0
  let lastReadAt = 0
  let states = new Map<string, ProjectionState>()
  let generation = 0
  let refreshedGeneration = -1
  let inflight: Promise<void> | undefined
  // Only the latest refresh may publish: one past its deadline is abandoned.
  let latestRun = 0
  let stopTimer: (() => void) | undefined
  let failing = false
  const warned = new Set<string>()

  const sourceProjections = (): readonly SourceProjection[] => [
    ...options.projections.listObjects(),
    ...options.projections.listLinks(),
  ]

  const refresh = (): Promise<void> => {
    if (inflight) return inflight
    latestRun += 1
    const run = latestRun
    const deadlineMs = maxAgeMs()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        latestRun += 1
        reject(
          new Error(
            `[Sixb] Reading the dataset versions projections applied took longer than ${deadlineMs / 1000}s.`
          )
        )
      }, deadlineMs)
      timer.unref?.()
    })
    const work = read(run)
    // The deadline may settle first; the abandoned read must not report an unhandled rejection.
    work.catch(() => {})
    inflight = Promise.race([work, deadline]).finally(() => {
      clearTimeout(timer)
      inflight = undefined
    })
    return inflight
  }

  const read = async (run: number) => {
    const startedAt = now()
    const startedGeneration = generation
    const active = await options.sources.listActive({ projectId: options.projectId })
    const applied = new Map(active.map((source) => [source.source.projectionId, source]))
    const next = new Map<string, ProjectionState>()
    await Promise.all(
      sourceProjections().map(async (projection) => {
        const source = applied.get(projection.id)
        if (!source) return
        const key = JSON.stringify([
          source.datasetVersion.datasetId,
          source.datasetVersion.versionId,
          source.projectionRevision,
        ])
        const previous = states.get(projection.id)
        if (previous && previous.key === key && !previous.retry) {
          next.set(projection.id, previous)
          return
        }
        const version = await readVersion(source.datasetVersion)
        pipelineOf ??= producingPipelines(options.pipelines)
        const contribution = appliedContribution(projection, source, version, {
          ontology: options.ontology,
          revisionOf: options.revisionOf,
          everyMarking: versionMarkings.everyMarking(),
          pipelineOf,
        })
        next.set(projection.id, { key, retry: version.kind !== "read", contribution })
      })
    )
    if (run !== latestRun) return
    states = next
    failing = false
    publish(next)
    refreshedAt = startedAt
    refreshedGeneration = startedGeneration
  }

  /** Read and classify a version; a version that cannot be read is sealed, then read again. */
  const readVersion = async (ref: {
    readonly datasetId: string
    readonly versionId: string
  }): Promise<AppliedVersionRead> => {
    try {
      const version = await options.lakeStorage.getVersion(ref.datasetId, ref.versionId)
      if (!version) return { kind: "missing" }
      return { kind: "read", version, classification: versionMarkings.classify(version) }
    } catch (error) {
      return { kind: "failed", error }
    }
  }

  const publish = (next: ReadonlyMap<string, ProjectionState>) => {
    const contributions = sourceProjections().flatMap((projection) => {
      const contribution = next.get(projection.id)?.contribution
      return contribution && contribution !== NO_CONTRIBUTION ? [contribution] : []
    })
    const nextFingerprint = JSON.stringify(contributions)
    // Equal content keeps the same object, so clearances resolved for it stay cached.
    if (snapshot && nextFingerprint === fingerprint) return
    snapshot = assembleAppliedMarkings(contributions)
    fingerprint = nextFingerprint
    const sealed = new Set(
      snapshot.notices.filter((notice) => notice.sealed).map((notice) => notice.projectionId)
    )
    // A projection sealed again after it was cleared warns again.
    for (const projectionId of warned) if (!sealed.has(projectionId)) warned.delete(projectionId)
    for (const notice of snapshot.notices) {
      if (!notice.sealed || warned.has(notice.projectionId)) continue
      warned.add(notice.projectionId)
      console.warn(notice.message)
    }
  }

  const stopRefreshing = () => {
    stopTimer?.()
    stopTimer = undefined
  }

  const tick = () => {
    if (inflight) return
    if (now() - lastReadAt > IDLE_REFRESHES * intervalMs) {
      stopRefreshing()
      return
    }
    refresh().then(
      () => {
        failing = false
      },
      (error: unknown) => {
        if (failing) return
        failing = true
        console.warn(
          `[Sixb] Could not read the dataset versions projections applied: ${sentence(errorMessage(error))} Reads keep the markings read before for ${maxAgeMs() / 1000}s, then fail until it succeeds.`
        )
      }
    )
  }

  const current = async (): Promise<AppliedMarkingsSnapshot> => {
    if (versionMarkings.everyMarking().size === 0) return NO_APPLIED_MARKINGS
    lastReadAt = now()
    // An invalidation during a refresh is only covered by a refresh that starts after it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (snapshot && refreshedGeneration === generation && now() - refreshedAt <= maxAgeMs()) {
        return snapshot
      }
      try {
        await refresh()
        // A read keeps the snapshot fresh in the background; stopping lasts until the next one.
        stopTimer ??= schedule(tick, intervalMs)
      } catch (error) {
        if (snapshot && now() - refreshedAt <= maxAgeMs()) return snapshot
        throw new Error(
          `[Sixb] Cannot read the dataset versions projections applied, so markings cannot be enforced: ${errorMessage(error)}`,
          { cause: error }
        )
      }
    }
    if (!snapshot) throw new Error("[Sixb] Applied markings were not read.")
    return snapshot
  }

  return {
    affects: (clearances) => {
      for (const markingId of versionMarkings.everyMarking()) {
        if (!clearances.has(markingId)) return true
      }
      return false
    },
    current,
    // Also before the first snapshot: a read in flight may have listed the sources before it.
    invalidate: () => {
      generation += 1
    },
    stopRefreshing,
    setRefreshInterval: (next) => {
      intervalMs = next
      if (stopTimer) {
        stopRefreshing()
        stopTimer = schedule(tick, intervalMs)
      }
    },
  }
}

function scheduleUnref(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs)
  // A refresh never keeps a process alive on its own.
  timer.unref?.()
  return () => clearInterval(timer)
}
