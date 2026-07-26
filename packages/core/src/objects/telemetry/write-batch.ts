/**
 * Low-level write: append normalized telemetry points through the ontology Materializer.
 *
 * Shared by the batch operation and the per-property appenders in ObjectByIdHandle. The Materializer
 * persists immutable point history, derives latest telemetry state, and writes the commit's outbox
 * facts in one transaction, so this leaf never appends events or writes providers itself.
 */
import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../../authorization"
import { assertPrivileged } from "../../authorization"
import type { TelemetryCommitResult, TelemetryPointWrite } from "../../materialization/model"
import type { RuntimeMaterializerContext } from "../materializer-adapter"
import { publishCommittedFacts } from "../materializer-adapter"

export type TelemetryWriteContext = RuntimeMaterializerContext & {
  readonly authorization?: AuthorizationContext
}

export async function writeTelemetryBatch(
  ctx: TelemetryWriteContext,
  points: readonly TelemetryPointWrite[]
): Promise<TelemetryCommitResult | null> {
  assertPrivileged(ctx, "appendTelemetry")
  if (points.length === 0) return null

  const commit = await ctx.materializer.telemetry.append({
    source: { kind: "runtime", requestId: randomUUID() },
    points,
  })
  await publishCommittedFacts(ctx, commit)
  return commit
}
