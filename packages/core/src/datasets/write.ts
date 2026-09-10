import type { BlobStorage, FileRef } from "../blob-storage"
import { isFileRef } from "../blob-storage"
import { isPlainRecord } from "../json"
import type { DatasetMergeCommitResult } from "../lake-storage/merge"
import { getDatasetMergeChangeValidationError } from "../lake-storage/merge-validation"
import type {
  DatasetProducer,
  DatasetRow,
  DatasetWriteMode,
  LakeStorage,
} from "../lake-storage/types"
import type { MergeChange } from "./changes"
import type { DatasetDefinition } from "./types"
import { getDatasetRowValidationError } from "./validation"

export interface DatasetWriteValue {
  readonly value: unknown
}

export interface WriteDatasetInput<TValue extends DatasetWriteValue = DatasetWriteValue> {
  readonly lakeStorage: LakeStorage
  readonly blobStorage: Pick<BlobStorage, "stat">
  readonly dataset: DatasetDefinition
  readonly mode: DatasetWriteMode | "merge"
  readonly signal: AbortSignal
  /** Lazy so a merge's latest-version guard is checked before fetching source data. */
  readValues(): Promise<Iterable<TValue> | AsyncIterable<TValue>>
  readonly producer?: DatasetProducer
  readonly expectedLatestVersionId?: string
  readonly commitMessage?: string
  /** Diagnostic label for the caller, including its component prefix. */
  readonly sourceLabel?: string
  /** Progress includes validated values even if the operation subsequently fails. */
  onRead?(rowsRead: number): void
  /** Attach caller-owned source provenance to a validation failure. */
  mapValidationError?(error: unknown, value: TValue, itemIndex: number): unknown
}

export type WriteDatasetResult = DatasetMergeCommitResult & { readonly rowsRead: number }

/**
 * Validate, stage, and commit one dataset write using existing lake sessions.
 *
 * The caller owns fetching/cancelling its source, execution bookkeeping, and publishing the
 * dataset-update notification for a `created` result. This operation returns immediately after
 * the lake commit; it does not wait for downstream pipelines or projections.
 */
export async function writeDataset<TValue extends DatasetWriteValue>(
  input: WriteDatasetInput<TValue>
): Promise<WriteDatasetResult> {
  const { lakeStorage, dataset, signal } = input
  let abortWrite: (() => Promise<void>) | undefined
  let rowsRead = 0
  const onRead = () => {
    rowsRead += 1
    input.onRead?.(rowsRead)
  }

  throwIfAborted(signal)
  await lakeStorage.createDataset(dataset)
  try {
    throwIfAborted(signal)
    const reconcileSnapshot = dataset.sequenceBy !== undefined && input.mode === "snapshot"
    if (input.mode === "merge" || reconcileSnapshot) {
      const session = await lakeStorage.beginMerge({
        dataset,
        expectedLatestVersionId: input.expectedLatestVersionId,
        producer: input.producer,
      })
      abortWrite = () => session.abort()
      throwIfAborted(signal)
      const values = await input.readValues()
      throwIfAborted(signal)
      await session.writeChanges(
        validatedValues(
          input,
          values,
          async (value, itemIndex) =>
            reconcileSnapshot
              ? { kind: "upsert" as const, row: await validateRow(value, input, itemIndex) }
              : validateMergeChange(value, input, itemIndex),
          onRead
        )
      )
      throwIfAborted(signal)
      const result = await session.commit({
        commitMessage: input.commitMessage,
        retryOnConflict: dataset.sequenceBy !== undefined,
        signal,
      })
      return { ...result, rowsRead }
    }

    const values = await input.readValues()
    throwIfAborted(signal)
    const session = await lakeStorage.beginWrite({
      dataset,
      mode: input.mode,
      producer: input.producer,
    })
    abortWrite = () => session.abort()
    await session.writeRows(
      validatedValues(
        input,
        values,
        (value, itemIndex) => validateRow(value, input, itemIndex),
        onRead
      )
    )
    throwIfAborted(signal)

    // Preserve sync semantics: an empty append must not invent an initial dataset version.
    if (rowsRead === 0 && input.mode === "append") {
      const version = await lakeStorage.getLatestVersion(dataset.id)
      await session.abort()
      return { outcome: "unchanged", version, rowsRead }
    }

    const { outcome, ...version } = await session.commit({
      expectedLatestVersionId: input.expectedLatestVersionId,
      commitMessage: input.commitMessage,
    })
    return { outcome, version, rowsRead }
  } catch (error) {
    // Cleanup must not replace the source, validation, cancellation, or commit failure.
    await abortWrite?.().catch(() => {})
    throw error
  }
}

async function* validatedValues<TValue extends DatasetWriteValue, TResult>(
  input: WriteDatasetInput<TValue>,
  values: Iterable<TValue> | AsyncIterable<TValue>,
  validate: (value: unknown, itemIndex: number) => Promise<TResult>,
  onRead: () => void
): AsyncIterable<TResult> {
  let itemIndex = 0
  for await (const sourceValue of values) {
    throwIfAborted(input.signal)
    itemIndex += 1
    let value: TResult
    try {
      value = await validate(sourceValue.value, itemIndex)
    } catch (error) {
      throw input.mapValidationError
        ? input.mapValidationError(error, sourceValue, itemIndex)
        : error
    }
    onRead()
    yield value
  }
}

function sourceLabel(input: Pick<WriteDatasetInput, "dataset" | "sourceLabel">): string {
  return input.sourceLabel ?? `[Sixb] Dataset '${input.dataset.id}' writer`
}

async function validateRow(
  value: unknown,
  input: WriteDatasetInput,
  itemIndex: number
): Promise<DatasetRow> {
  if (!isPlainRecord(value)) {
    throw new Error(
      `${sourceLabel(input)} returned an invalid row at item ${itemIndex}. Dataset rows must be plain objects.`
    )
  }
  const validationError = getDatasetRowValidationError(value, input.dataset)
  if (validationError) {
    throw new Error(
      `${sourceLabel(input)} returned an invalid row at item ${itemIndex}. ${validationError}`
    )
  }
  await verifyRowFileRefs(value, input, itemIndex)
  return value
}

async function validateMergeChange(
  value: unknown,
  input: WriteDatasetInput,
  itemIndex: number
): Promise<MergeChange<DatasetRow, DatasetRow>> {
  const validationError = getDatasetMergeChangeValidationError(value, input.dataset)
  if (validationError) {
    throw new Error(
      `${sourceLabel(input)} returned an invalid merge change at item ${itemIndex}. ${validationError}`
    )
  }
  const change = value as MergeChange<DatasetRow, DatasetRow>
  if (change.kind === "upsert") await verifyRowFileRefs(change.row, input, itemIndex)
  return change
}

async function verifyRowFileRefs(
  row: DatasetRow,
  input: WriteDatasetInput,
  itemIndex: number
): Promise<void> {
  for (const column of input.dataset.schema.columns) {
    if (column.type !== "fileRef") continue
    const value = row[column.name]
    if (isFileRef(value)) await verifyFileRef(value, input, column.name, itemIndex)
  }
}

async function verifyFileRef(
  fileRef: FileRef,
  input: WriteDatasetInput,
  columnName: string,
  itemIndex: number
): Promise<void> {
  const blobInfo = await input.blobStorage.stat(fileRef.blobId)
  const context = `${sourceLabel(input)} returned row ${itemIndex} with dataset '${input.dataset.id}' column '${columnName}'`
  if (!blobInfo) {
    throw new Error(`${context} referencing unknown blob '${fileRef.blobId}'.`)
  }
  if (blobInfo.digest !== fileRef.digest) {
    throw new Error(
      `${context} referencing blob '${fileRef.blobId}' with digest '${fileRef.digest}', but blob storage has '${blobInfo.digest}'.`
    )
  }
  if (blobInfo.sizeBytes !== fileRef.sizeBytes) {
    throw new Error(
      `${context} referencing blob '${fileRef.blobId}' with size ${fileRef.sizeBytes}, but blob storage has ${blobInfo.sizeBytes}.`
    )
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error(
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "[Sixb] Dataset write was cancelled."
  )
  error.name = "AbortError"
  throw error
}
