import type { LakeStorage } from "../lake-storage/types"
import type { OntologyDefinitionCatalog } from "../ontology/registry"
import type { PipelineDefinition } from "../pipelines/types"
import type { ProjectionDefinitionCatalog } from "../projections/registry"
import type { ActiveOntologySource, OntologySourceStorage } from "../storage/ontology"
import {
  type AppliedVersionRead,
  appliedContribution,
  appliedVersionMarkings,
  type EventOriginRef,
  errorMessage,
  eventOriginMarkings,
  producingPipelines,
  removedProjectionContribution,
  type SourceProjection,
  sentence,
} from "./applied-markings-contribution"
import {
  type AppliedContribution,
  type AppliedMarkingsSnapshot,
  assembleAppliedMarkings,
  NO_APPLIED_MARKINGS,
  NO_CONTRIBUTION,
  withPropertyMarkings,
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
 * lacking them, like a type they have no view grant for. A source whose projection the code no
 * longer declares makes what it wrote unreadable to readers lacking any marking of its version.
 *
 * Lifecycle: the snapshot is read when a read needs it, with no background work.
 * - A read reads it with one storage query for the projections' active sources; only sources
 *   whose applied version or definition changed are classified again. A project whose columns
 *   carry no marking reads nothing.
 * - A read uses a snapshot younger than {@link APPLIED_MARKINGS_FRESH_MS}. An older one, up to
 *   {@link APPLIED_MARKINGS_MAX_AGE_MS}, is used while one refresh runs behind the read. Past that
 *   age, or before any snapshot, the read waits for a refresh and fails if it fails or hangs past
 *   the same bound. Other servers so see a newly applied version within seconds.
 * - A host that applies a projection invalidates the snapshot, so its next read refreshes first:
 *   `sixb dev` sees a version at once.
 */
export interface AppliedMarkings {
  /** Whether readers with these clearances can be denied anything the code alone allows. */
  affects(clearances: ReadonlySet<string>): boolean
  /** The current snapshot, refreshed on demand. */
  current(): Promise<AppliedMarkingsSnapshot>
  /** A projection applied a version in this process: the next read refreshes first. */
  invalidate(): void
  /**
   * The snapshot with the markings an object event's origin version carries on the properties
   * its projection maps: the event holds that version's values, whatever version the projection
   * applied since. Reads each version once, keeping the last few.
   */
  forEventOrigin(
    snapshot: AppliedMarkingsSnapshot,
    origin: EventOriginRef
  ): Promise<AppliedMarkingsSnapshot>
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
  readonly sources: Pick<OntologySourceStorage, "listActive" | "getActiveTarget">
  /** A monotonic clock in milliseconds. */
  readonly now?: () => number
  /** For this repo's tests: the bound past which a read waits, and a refresh fails. */
  readonly maxAgeMs?: number
}

/** Origin versions, and snapshots combined with them, kept for the events read next. */
const EVENT_ORIGINS_KEPT = 64

/** A read uses a snapshot younger than this as it is. */
export const APPLIED_MARKINGS_FRESH_MS = 5_000
/** A read waits for a snapshot older than this, and a refresh that takes longer fails. */
export const APPLIED_MARKINGS_MAX_AGE_MS = 10_000

interface SourceState {
  /** The applied version and revision the contribution was computed for. */
  readonly key: string
  /** The version or the source's target could not be read: seal now, read again next time. */
  readonly retry: boolean
  readonly contribution: AppliedContribution
}

export function createAppliedMarkings(options: AppliedMarkingsOptions): AppliedMarkings {
  const maxAgeMs = options.maxAgeMs ?? APPLIED_MARKINGS_MAX_AGE_MS
  const freshMs = Math.min(APPLIED_MARKINGS_FRESH_MS, maxAgeMs / 2)
  const now = options.now ?? (() => performance.now())
  const versionMarkings = options.versionMarkings
  let pipelineOf: ((datasetId: string) => string | undefined) | undefined

  let snapshot: AppliedMarkingsSnapshot | undefined
  let fingerprint: string | undefined
  let refreshedAt = 0
  let states = new Map<string, SourceState>()
  let generation = 0
  let refreshedGeneration = -1
  let inflight: Promise<void> | undefined
  // Only the latest refresh may publish: one past its deadline is abandoned.
  let latestRun = 0
  let failing = false
  const warned = new Set<string>()

  const refresh = (): Promise<void> => {
    if (inflight) return inflight
    latestRun += 1
    const run = latestRun
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        latestRun += 1
        reject(
          new Error(
            `[Sixb] Reading the dataset versions projections applied took longer than ${maxAgeMs / 1000}s.`
          )
        )
      }, maxAgeMs)
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
    const declared = new Map<string, SourceProjection>(
      [...options.projections.listObjects(), ...options.projections.listLinks()].map(
        (projection) => [projection.id, projection]
      )
    )
    const next = new Map<string, SourceState>()
    await Promise.all(
      active.map(async (source) => {
        const projectionId = source.source.projectionId
        const projection = declared.get(projectionId)
        const key = JSON.stringify([
          source.datasetVersion.datasetId,
          source.datasetVersion.versionId,
          source.projectionRevision,
          projection !== undefined,
        ])
        const previous = states.get(projectionId)
        if (previous && previous.key === key && !previous.retry) {
          next.set(projectionId, previous)
          return
        }
        const version = await readVersion(source.datasetVersion)
        if (!projection) {
          next.set(projectionId, await removedSource(source, version, key))
          return
        }
        pipelineOf ??= producingPipelines(options.pipelines)
        const contribution = appliedContribution(projection, source, version, {
          ontology: options.ontology,
          revisionOf: options.revisionOf,
          everyMarking: versionMarkings.everyMarking(),
          pipelineOf,
        })
        next.set(projectionId, { key, retry: version.kind !== "read", contribution })
      })
    )
    if (run !== latestRun) return
    states = next
    failing = false
    publish(next)
    refreshedAt = startedAt
    refreshedGeneration = startedGeneration
  }

  /**
   * A source the code no longer declares: no definition says what it wrote, so it is read from
   * the source, and only when its version carries a marking.
   */
  const removedSource = async (
    source: ActiveOntologySource,
    version: AppliedVersionRead,
    key: string
  ): Promise<SourceState> => {
    const retry = version.kind !== "read"
    const markings = appliedVersionMarkings(version, versionMarkings.everyMarking())
    if (markings.length === 0) return { key, retry, contribution: NO_CONTRIBUTION }
    const target = await options.sources.getActiveTarget({
      projectId: options.projectId,
      source: source.source,
    })
    return { key, retry, contribution: removedProjectionContribution(source, target, markings) }
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

  const publish = (next: ReadonlyMap<string, SourceState>) => {
    const contributions = [...next]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .flatMap(([, state]) => (state.contribution === NO_CONTRIBUTION ? [] : [state.contribution]))
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

  /** One refresh behind reads that keep using the snapshot; a failure is reported once a streak. */
  const refreshBehind = () => {
    if (inflight) return
    refresh().catch((error: unknown) => {
      if (failing) return
      failing = true
      console.warn(
        `[Sixb] Could not read the dataset versions projections applied: ${sentence(errorMessage(error))} Reads keep the markings read before for up to ${maxAgeMs / 1000}s, then fail until it succeeds.`
      )
    })
  }

  const current = async (): Promise<AppliedMarkingsSnapshot> => {
    if (versionMarkings.everyMarking().size === 0) return NO_APPLIED_MARKINGS
    // An invalidation during a refresh is only covered by a refresh that starts after it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (snapshot && refreshedGeneration === generation) {
        const age = now() - refreshedAt
        if (age < freshMs) return snapshot
        if (age <= maxAgeMs) {
          refreshBehind()
          return snapshot
        }
      }
      try {
        await refresh()
      } catch (error) {
        if (snapshot && now() - refreshedAt <= maxAgeMs) return snapshot
        throw new Error(
          `[Sixb] Cannot read the dataset versions projections applied, so markings cannot be enforced: ${errorMessage(error)}`,
          { cause: error }
        )
      }
    }
    if (!snapshot) throw new Error("[Sixb] Applied markings were not read.")
    return snapshot
  }

  // A version's classification never changes. One that could not be read is read again.
  const originVersions = new Map<string, Promise<AppliedVersionRead>>()
  const readOriginVersion = (origin: EventOriginRef): Promise<AppliedVersionRead> => {
    const key = JSON.stringify([origin.datasetId, origin.datasetVersionId])
    let version = originVersions.get(key)
    if (version) {
      originVersions.delete(key)
    } else {
      const read = readVersion({ datasetId: origin.datasetId, versionId: origin.datasetVersionId })
      void read.then((result) => {
        if (result.kind === "failed" && originVersions.get(key) === read) originVersions.delete(key)
      })
      version = read
    }
    keep(originVersions, key, version)
    return version
  }
  const combined = new WeakMap<AppliedMarkingsSnapshot, Map<string, AppliedMarkingsSnapshot>>()
  const forEventOrigin = async (snapshot: AppliedMarkingsSnapshot, origin: EventOriginRef) => {
    const read = await readOriginVersion(origin)
    const key = JSON.stringify([
      origin.projectionId,
      origin.datasetId,
      origin.datasetVersionId,
      origin.objectTypeId,
      read.kind,
    ])
    let bySnapshot = combined.get(snapshot)
    const cached = bySnapshot?.get(key)
    if (cached) return cached
    const projection = options.projections
      .listObjects()
      .find((candidate) => candidate.id === origin.projectionId)
    const result = withPropertyMarkings(
      snapshot,
      eventOriginMarkings(projection, origin, read, {
        ontology: options.ontology,
        everyMarking: versionMarkings.everyMarking(),
      })
    )
    // Equal snapshots share resolved clearances; a failed read is not kept.
    if (read.kind !== "failed") {
      bySnapshot ??= new Map()
      combined.set(snapshot, bySnapshot)
      keep(bySnapshot, key, result)
    }
    return result
  }

  return {
    forEventOrigin,
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
  }
}

/** Insert as the newest entry, dropping the oldest past the bound. */
function keep<TValue>(map: Map<string, TValue>, key: string, value: TValue): void {
  map.set(key, value)
  if (map.size <= EVENT_ORIGINS_KEPT) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}
