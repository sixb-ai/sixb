import { MaterializationValidationError } from "../../../materialization/errors"
import type { OntologyMaterializationOrigin } from "../../../materialization/model"
import type { OntologyCommitOriginSelector, OntologyCommitRecord } from "../commits"
import type {
  MaterializationWorkRecord,
  StoredLinkOverride,
  StoredObjectOverride,
} from "../materializations"
import type { OntologyOutboxRecord } from "../outbox"
import type { OntologySourceRecord, StageSourceAssertion } from "../sources"

export interface InMemorySourceMaterialization extends OntologySourceRecord {
  readonly rowsByEntity: Map<string, StageSourceAssertion>
  readonly rootOrdinals: Map<string, number>
  readonly ordinalRoots: Map<number, string>
}

export interface InMemoryStoredObjectOverride extends StoredObjectOverride {
  readonly projectId: string
}

export interface InMemoryStoredLinkOverride extends StoredLinkOverride {
  readonly projectId: string
}

export interface InMemoryOntologyState {
  readonly commitsById: Map<string, OntologyCommitRecord>
  readonly commitIdByIdempotency: Map<string, string>
  readonly commitIdByOrigin: Map<string, string>
  readonly sourceMaterializations: Map<string, InMemorySourceMaterialization>
  readonly objectOverrides: Map<string, InMemoryStoredObjectOverride>
  readonly linkOverrides: Map<string, InMemoryStoredLinkOverride>
  readonly outbox: Map<string, OntologyOutboxRecord>
}

/** @internal Test-only failure injection for the in-memory ontology provider. */
export interface InMemoryOntologyStorageTestHooks {
  readonly beforeRead?: (boundary: string) => void
  readonly beforeWrite?: (boundary: string, ordinal: number) => void
  readonly observeBuffer?: (boundary: string, rows: number) => void
  readonly observeWork?: (records: readonly MaterializationWorkRecord[]) => void
}

export function createInMemoryOntologyState(): InMemoryOntologyState {
  return {
    commitsById: new Map(),
    commitIdByIdempotency: new Map(),
    commitIdByOrigin: new Map(),
    sourceMaterializations: new Map(),
    objectOverrides: new Map(),
    linkOverrides: new Map(),
    outbox: new Map(),
  }
}

export function projectEntityKey(projectId: string, entityKey: string): string {
  return JSON.stringify([projectId, entityKey])
}

export function sourceMaterializationKey(
  projectId: string,
  sourceId: string,
  materializationId: string
): string {
  return JSON.stringify([projectId, sourceId, materializationId])
}

export function sourceMaterializationRecord(
  materialization: InMemorySourceMaterialization
): OntologySourceRecord {
  const {
    rowsByEntity: _rows,
    rootOrdinals: _roots,
    ordinalRoots: _ordinals,
    ...record
  } = materialization
  return structuredClone(record)
}

export function commitKey(projectId: string, commitId: string): string {
  return JSON.stringify([projectId, commitId])
}

export function idempotencyKey(projectId: string, key: string): string {
  return JSON.stringify([projectId, key])
}

export function ontologyCommitOriginSelector(
  origin: OntologyMaterializationOrigin
): OntologyCommitOriginSelector | null {
  if (origin.kind === "action") return { kind: "action", actionRunId: origin.runId }
  if (origin.kind === "projection") {
    return { kind: "projection", projectionRunId: origin.projectionRunId }
  }
  if (origin.kind === "telemetry" && origin.source.kind === "projection") {
    return {
      kind: "telemetry",
      projectionRunId: origin.source.projectionRunId,
      batchOrdinal: origin.source.batchOrdinal,
    }
  }
  return null
}

export function commitOriginKey(projectId: string, origin: OntologyCommitOriginSelector): string {
  switch (origin.kind) {
    case "action":
      return JSON.stringify([projectId, origin.kind, origin.actionRunId])
    case "projection":
      return JSON.stringify([projectId, origin.kind, origin.projectionRunId])
    case "telemetry":
      return JSON.stringify([projectId, origin.kind, origin.projectionRunId, origin.batchOrdinal])
  }
}

export function outboxKey(projectId: string, eventId: string): string {
  return JSON.stringify([projectId, eventId])
}

export function cloneOntologyState(state: InMemoryOntologyState): InMemoryOntologyState {
  return structuredClone(state)
}

export function restoreOntologyState(
  target: InMemoryOntologyState,
  snapshot: InMemoryOntologyState
): void {
  for (const key of Object.keys(target) as (keyof InMemoryOntologyState)[]) {
    const targetMap = target[key] as Map<unknown, unknown>
    const sourceMap = structuredClone(snapshot[key]) as Map<unknown, unknown>
    targetMap.clear()
    for (const [entryKey, value] of sourceMap) targetMap.set(entryKey, value)
  }
}

/** Insert `value` into a sorted, size-bounded accumulator, dropping the largest entry past `limit`. */
export function insertBounded<T>(
  values: T[],
  value: T,
  limit: number,
  compare: (left: T, right: T) => number
): void {
  let index = values.findIndex((candidate) => compare(value, candidate) < 0)
  if (index < 0) index = values.length
  values.splice(index, 0, value)
  if (values.length > limit) values.pop()
}

export function assertNonblank(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MaterializationValidationError(`${label} must be nonblank.`)
  }
}

export function assertTimestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    throw new MaterializationValidationError(`${label} must be a valid timestamp.`)
  }
  return milliseconds
}
