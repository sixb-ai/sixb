import { buildEditCommitPlanEvents, type EventDraft } from "../events"
import type { OntologyRegistry } from "../ontology/registry"
import { isStorageSerializationFailure } from "../storage/errors"
import type { Storage } from "../storage/types"
import type { EditBatchInput, EditCommitDiff } from "./types"
import { planEditBatch } from "./validation"

const DEFAULT_MAX_SERIALIZATION_ATTEMPTS = 3
const SERIALIZATION_BASE_DELAY_MS = 10
const SERIALIZATION_MAX_DELAY_MS = 200

/** Tunes serializable-transaction retries. Both fields are injectable for deterministic tests. */
export interface SerializationRetryOptions {
  /** Total attempts, including the first. Defaults to 3; values below 1 are clamped to 1. */
  readonly maxAttempts?: number
  /** Awaited before each retry. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>
}

interface ResolvedSerializationRetryPolicy {
  readonly maxAttempts: number
  readonly sleep: (ms: number) => Promise<void>
}

interface ApplyEditBatchCommitInput {
  readonly storage: Pick<Storage, "objects">
  readonly projectId: string
  readonly ontology: Pick<
    OntologyRegistry,
    "resolveObjectType" | "getPrimaryPropertyId" | "getValueTypesById" | "isValidLinkTarget"
  >
  readonly batch: EditBatchInput
  readonly committedAt: Date
  readonly idempotencyKeyPrefix?: string
}

export interface CommitEditBatchResult {
  readonly diff: EditCommitDiff
  readonly events: readonly EventDraft[]
  readonly committedAt: Date
}

/** Plans and applies an EditBatch using the caller's active transaction. */
export async function applyEditBatchCommit(
  input: ApplyEditBatchCommitInput
): Promise<CommitEditBatchResult> {
  const plan = await planEditBatch({
    projectId: input.projectId,
    ontology: input.ontology,
    storage: input.storage,
    batch: input.batch,
  })

  await input.storage.objects.applyEditCommitPlan({
    projectId: input.projectId,
    plan,
    committedAt: input.committedAt,
  })

  return {
    diff: plan.diff,
    events: buildEditCommitPlanEvents({
      plan,
      idempotencyKeyPrefix: input.idempotencyKeyPrefix,
    }),
    committedAt: input.committedAt,
  }
}

/** Runs a deterministic storage callback with bounded retries for serialization failures. */
export async function runWithStorageSerializationRetry<T>(
  run: () => Promise<T>,
  options: SerializationRetryOptions = {}
): Promise<T> {
  const policy = resolveSerializationRetryPolicy(options)

  for (let failures = 0; ; failures++) {
    try {
      return await run()
    } catch (error) {
      const attempted = failures + 1
      if (!isStorageSerializationFailure(error) || attempted >= policy.maxAttempts) {
        throw error
      }

      await policy.sleep(serializationBackoffMs(attempted))
    }
  }
}

function resolveSerializationRetryPolicy(
  options: SerializationRetryOptions
): ResolvedSerializationRetryPolicy {
  return {
    maxAttempts: Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_SERIALIZATION_ATTEMPTS)),
    sleep: options.sleep ?? defaultSerializationSleep,
  }
}

/** Full-jitter exponential backoff, capped to keep worker retries responsive. */
function serializationBackoffMs(failures: number): number {
  const cap = Math.min(
    SERIALIZATION_MAX_DELAY_MS,
    SERIALIZATION_BASE_DELAY_MS * 2 ** (failures - 1)
  )
  return Math.random() * cap
}

function defaultSerializationSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
