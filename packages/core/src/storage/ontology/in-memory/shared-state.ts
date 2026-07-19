import type { OntologyCommitRecord } from "../commits"
import type {
  MaterializationRunBookkeeping,
  MaterializationWorkRecord,
  StoredLinkOverride,
  StoredObjectOverride,
} from "../materializations"
import type { OntologyOutboxRecord } from "../outbox"
import type { OntologySourceRecord, StageSourceAssertion } from "../sources"

export interface InMemorySourceGeneration {
  readonly projectId: string
  readonly sourceId: string
  readonly generationId: string
  readonly stagedAt: string
  readonly rowsByEntity: Map<string, StageSourceAssertion>
  readonly rootOrdinals: Map<string, number>
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
  readonly activeSources: Map<string, OntologySourceRecord>
  readonly generations: Map<string, InMemorySourceGeneration>
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
  readonly applyBookkeeping?: (
    projectId: string,
    bookkeeping: MaterializationRunBookkeeping
  ) => Promise<void> | void
}

export function createInMemoryOntologyState(): InMemoryOntologyState {
  return {
    commitsById: new Map(),
    commitIdByIdempotency: new Map(),
    activeSources: new Map(),
    generations: new Map(),
    objectOverrides: new Map(),
    linkOverrides: new Map(),
    outbox: new Map(),
  }
}

export function projectEntityKey(projectId: string, entityKey: string): string {
  return JSON.stringify([projectId, entityKey])
}

export function sourceKey(projectId: string, sourceId: string): string {
  return JSON.stringify([projectId, sourceId])
}

export function generationKey(projectId: string, sourceId: string, generationId: string): string {
  return JSON.stringify([projectId, sourceId, generationId])
}

export function commitKey(projectId: string, commitId: string): string {
  return JSON.stringify([projectId, commitId])
}

export function idempotencyKey(projectId: string, key: string): string {
  return JSON.stringify([projectId, key])
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
