/**
 * Shared streaming-batch driver for projection runners.
 *
 * Object, link, and telemetry projections all stream dataset rows, project each
 * into a batch item, and flush in batches. The control flow — counter init,
 * abort checks, the batchSize-triggered flush, the end-of-stream flush, and
 * progress reporting — is identical across kinds; only how a row projects, what
 * a flush writes, and which columns to read differ. Each runner supplies those
 * via {@link StreamingProjectionSpec}; everything else lives here once.
 */
import type { DatasetRow } from "@sixb/core"
import type {
  ProjectionExecutionResult,
  ProjectionProgressReporter,
  ProjectionWorkerContext,
} from "./types"
import {
  createZeroCounters,
  type MutableProjectionCounters,
  snapshotCounters,
  throwIfAborted,
} from "./utils"

/** Outcome of projecting one dataset row: queue an item, skip cleanly, or fail. */
export type RowProjection<TItem> =
  | { readonly status: "item"; readonly item: TItem }
  | { readonly status: "skip" }
  | { readonly status: "fail"; readonly errorMessage: string }

export interface FlushContext {
  readonly counters: MutableProjectionCounters
  readonly rememberError: (message: string) => void
}

export interface StreamingProjectionSpec<TItem> {
  readonly datasetId: string
  readonly versionId: string
  readonly readColumns: readonly string[]
  /** Projects a raw dataset row into a batch item. May capture a plan, dedup set, etc. */
  projectRow(row: DatasetRow): RowProjection<TItem>
  /** Writes a full batch and bumps the kind-specific success counters. */
  flushBatch(items: readonly TItem[], ctx: FlushContext): Promise<void>
  /** Optional secondary counter for a clean (blank) skip; rowsSkipped is always bumped by the driver. */
  onSkip?(counters: MutableProjectionCounters): void
  /** Optional secondary counter for a row-level projection failure; rowsSkipped is always bumped. */
  onFail?(counters: MutableProjectionCounters): void
}

export async function runStreamingProjection<TItem>(input: {
  readonly runtime: ProjectionWorkerContext
  readonly signal: AbortSignal
  readonly batchSize: number
  readonly onProgress?: ProjectionProgressReporter
  readonly spec: StreamingProjectionSpec<TItem>
}): Promise<ProjectionExecutionResult> {
  const { runtime, signal, batchSize, onProgress, spec } = input
  const counters = createZeroCounters()
  const batch: TItem[] = []
  let firstErrorMessage: string | undefined

  const rememberError = (message: string): void => {
    firstErrorMessage ??= message
  }

  const flush = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }
    await spec.flushBatch(batch.splice(0, batch.length), { counters, rememberError })
    await onProgress?.(snapshotCounters(counters))
  }

  for await (const row of runtime.lakeStorage.readRows({
    datasetId: spec.datasetId,
    versionId: spec.versionId,
    columns: spec.readColumns,
  })) {
    throwIfAborted(signal)
    counters.rowsProcessed += 1

    const projected = spec.projectRow(row)
    if (projected.status === "fail") {
      counters.rowsSkipped += 1
      spec.onFail?.(counters)
      rememberError(projected.errorMessage)
      continue
    }
    if (projected.status === "skip") {
      counters.rowsSkipped += 1
      spec.onSkip?.(counters)
      continue
    }

    batch.push(projected.item)
    if (batch.length >= batchSize) {
      await flush()
    }
  }

  throwIfAborted(signal)
  await flush()
  throwIfAborted(signal)
  await onProgress?.(snapshotCounters(counters))

  return {
    ...snapshotCounters(counters),
    firstErrorMessage,
  }
}
