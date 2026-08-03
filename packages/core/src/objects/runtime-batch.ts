/**
 * Per-item mechanics shared by every runtime batch.
 *
 * One place owns the rules the public batch APIs promise: a local failure stays at its own input
 * position, an identical repeat collapses onto the first item and shares its result, a conflicting
 * repeat is rejected, and each item's Materializer outcomes map back to the position they came from.
 */

import { SixbError } from "../errors"
import type { OntologyEditOperation, OntologyOperationOutcome } from "../materialization/model"
import type { BatchItemResult } from "../runtime/types"
import {
  commitRuntimeBatch,
  type RuntimeMaterializerContext,
  requireItemOutcomes,
  toItemError,
} from "./materializer-adapter"

export interface RuntimeBatchItemPlan {
  /** Identity this item claims. A later item claiming it must be identical. */
  readonly key: string
  /** How that identity reads in an error message, e.g. `object 'room:r1'`. */
  readonly label: string
  /** Canonical content, so an identical repeat is recognized as one. */
  readonly fingerprint: string
  readonly operations: readonly OntologyEditOperation[]
}

export interface RuntimeItemBatch<TItem, TValue> {
  readonly ctx: RuntimeMaterializerContext
  readonly items: readonly TItem[]
  /** Lowers one item, throwing to record a local failure at that item's position. */
  plan(item: TItem, index: number): RuntimeBatchItemPlan
  /** Maps the outcomes of a fully successful item to its public value. */
  value(outcomes: readonly OntologyOperationOutcome[]): TValue
}

interface PlannedItem {
  readonly index: number
  readonly operations: readonly OntologyEditOperation[]
}

interface ClaimedIdentity {
  readonly index: number
  readonly fingerprint: string
}

export async function runRuntimeItemBatch<TItem, TValue>(
  batch: RuntimeItemBatch<TItem, TValue>
): Promise<readonly BatchItemResult<TValue>[]> {
  const { items } = batch
  if (items.length === 0) return []

  const results: BatchItemResult<TValue>[] = new Array(items.length)
  const planned: PlannedItem[] = []
  const claims = new Map<string, ClaimedIdentity>()
  /** Positions that repeat an earlier identical item and share its result. */
  const aliases = new Map<number, number>()

  for (const [index, item] of items.entries()) {
    let plan: RuntimeBatchItemPlan
    try {
      plan = batch.plan(item, index)
    } catch (error) {
      results[index] = {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      }
      continue
    }

    const claimed = claims.get(plan.key)
    if (claimed) {
      if (claimed.fingerprint !== plan.fingerprint) {
        results[index] = {
          ok: false,
          error: new SixbError(
            "ontology.invalid_value",
            `[Sixb] Conflicting duplicate ${plan.label} at batch positions ${claimed.index} and ${index}`
          ),
        }
        continue
      }
      aliases.set(index, claimed.index)
      continue
    }

    claims.set(plan.key, { index, fingerprint: plan.fingerprint })
    planned.push({ index, operations: plan.operations })
  }

  const commit = await commitRuntimeBatch(batch.ctx, planned)

  for (const { index } of planned) {
    const outcomes = requireItemOutcomes(commit, index)
    const failed = outcomes.find((outcome) => !outcome.ok)
    results[index] =
      failed?.ok === false
        ? { ok: false, error: toItemError(failed.error) }
        : { ok: true, value: batch.value(outcomes) }
  }
  for (const [index, source] of aliases) {
    results[index] = results[source]
  }
  return results
}
