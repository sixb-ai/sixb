/**
 * Service layer for telemetry operations.
 *
 * Resolves objectTypeId to a typed context and delegates to the leaf function.
 */
import type { SixbRuntimeContext } from "../../runtime/types"
import { resolveObjectContext } from "../context"
import { appendTelemetryBatch as appendTelemetryBatchLeaf } from "../telemetry"

export async function appendTelemetry(
  runtime: SixbRuntimeContext,
  objectTypeId: string,
  items: readonly { id: string; properties: Record<string, unknown>; at?: Date }[]
): Promise<void> {
  const ctx = resolveObjectContext(runtime, objectTypeId)
  await appendTelemetryBatchLeaf(ctx, items)
}
