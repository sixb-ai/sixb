import type { OntologyStorage, StageSourceAssertion } from "../storage/ontology"
import { chunkBySize } from "./chunking"
import type { MaterializerContext } from "./materializer-context"
import { normalizeProjectionSourceEntry } from "./normalize"
import type { ProjectionEntryValidator } from "./projection-entry-validator"
import { utf8JsonByteLength } from "./refs"
import type { ProjectionSourceEntry, ProjectionSourceRef } from "./types"

const INACTIVE_GENERATION_RETENTION_MS = 24 * 60 * 60 * 1_000

export interface StagedProjectionGeneration {
  readonly rootCount: number
  readonly assertionCount: number
}

export async function stageProjectionGeneration(
  context: Pick<MaterializerContext, "projectId" | "storage" | "batching">,
  input: {
    readonly source: ProjectionSourceRef
    readonly generationId: string
    readonly stagedAt: string
    readonly entries: AsyncIterable<ProjectionSourceEntry>
    readonly validateEntry: ProjectionEntryValidator
    readonly signal?: AbortSignal
  }
): Promise<StagedProjectionGeneration> {
  await context.storage.ontology.sources.stage({
    projectId: context.projectId,
    source: input.source,
    generationId: input.generationId,
    stagedAt: input.stagedAt,
    rows: [],
  })

  let rootCount = 0
  let assertionCount = 0
  async function* assertions(): AsyncIterable<StageSourceAssertion> {
    for await (const rawEntry of input.entries) {
      throwIfAborted(input.signal)
      const entry = input.validateEntry(normalizeProjectionSourceEntry(rawEntry))
      const stagingOrdinal = rootCount
      for (const assertion of entry.assertions) {
        assertionCount += 1
        yield { root: entry.root, assertion, stagingOrdinal }
      }
      rootCount += 1
    }
    throwIfAborted(input.signal)
  }

  for await (const rows of chunkBySize(assertions(), {
    maxRows: context.batching.sourceStageRows,
    maxBytes: context.batching.sourceStageBytes,
    byteLength: utf8JsonByteLength,
  })) {
    await context.storage.ontology.sources.stage({
      projectId: context.projectId,
      source: input.source,
      generationId: input.generationId,
      stagedAt: input.stagedAt,
      rows,
    })
  }
  return { rootCount, assertionCount }
}

export async function discardProjectionGeneration(
  storage: OntologyStorage,
  input: {
    readonly projectId: string
    readonly source: ProjectionSourceRef
    readonly generationId: string
  }
): Promise<void> {
  await bestEffort(() => storage.sources.discard(input))
}

export async function cleanupInactiveProjectionGenerations(
  storage: OntologyStorage,
  input: {
    readonly projectId: string
    readonly committedAt: string
    readonly limit: number
  }
): Promise<void> {
  await bestEffort(() =>
    storage.sources.cleanupInactive({
      projectId: input.projectId,
      olderThan: new Date(
        Date.parse(input.committedAt) - INACTIVE_GENERATION_RETENTION_MS
      ).toISOString(),
      limit: input.limit,
    })
  )
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Projection replacement aborted", "AbortError")
  }
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch {}
}
