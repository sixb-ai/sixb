import type {
  PinnedDatasetVersion,
  ProjectionExecution,
  ProjectionSourceEntry,
  ProjectionSourceRef,
} from "../../materialization/model"
import { utf8JsonByteLength } from "../../materialization/refs"
import type { StageSourceAssertion } from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { chunkBySize } from "../shared/chunking"
import { normalizeProjectionSourceEntry } from "../shared/normalize"
import type { ProjectionEntryValidator } from "./entry-validator"

export interface StagedProjectionMaterialization {
  readonly rootCount: number
  readonly assertionCount: number
}

/**
 * Persist and seal one explicit source-materialization candidate.
 *
 * A candidate is deliberately left staging/ready when execution is interrupted. The next claim
 * reclaims it with a fresh execution token; age is never used to infer abandonment.
 */
export async function stageProjectionMaterialization(
  context: Pick<
    MaterializerContext,
    "projectId" | "storage" | "batching" | "projectionRegistry" | "clock"
  >,
  input: {
    readonly source: ProjectionSourceRef
    readonly materializationId: string
    readonly execution: ProjectionExecution
    readonly projectionKind: "object" | "link"
    readonly datasetVersion: PinnedDatasetVersion
    readonly projectionRevision: string
    readonly ownershipHash: string
    readonly createdAt: string
    readonly entries: AsyncIterable<ProjectionSourceEntry>
    readonly validateEntry: ProjectionEntryValidator
    readonly signal?: AbortSignal
  }
): Promise<StagedProjectionMaterialization> {
  await context.storage.ontology.sources.beginMaterialization({
    projectId: context.projectId,
    source: input.source,
    materializationId: input.materializationId,
    execution: input.execution,
    projectionKind: input.projectionKind,
    protocol: "replacement",
    datasetVersion: input.datasetVersion,
    projectionRevision: input.projectionRevision,
    ownershipHash: input.ownershipHash,
    ontologyRevision: context.projectionRegistry.ontologyRevision,
    createdAt: input.createdAt,
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
    await context.storage.ontology.sources.stageRows({
      projectId: context.projectId,
      source: input.source,
      materializationId: input.materializationId,
      execution: input.execution,
      rows,
    })
  }

  await context.storage.ontology.sources.markReady({
    projectId: context.projectId,
    source: input.source,
    materializationId: input.materializationId,
    execution: input.execution,
    rootCount,
    assertionCount,
    readyAt: context.clock().toISOString(),
  })
  return { rootCount, assertionCount }
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
