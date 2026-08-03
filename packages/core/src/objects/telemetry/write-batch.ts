/**
 * Low-level write: append normalized telemetry points through the ontology Materializer.
 *
 * Shared by the batch operation and the per-property appenders in ObjectByIdHandle. The Materializer
 * persists immutable point history, derives latest telemetry state, and writes the commit's outbox
 * facts in one transaction, so this leaf never appends events or writes providers itself.
 */
import { randomUUID } from "node:crypto"
import type { AuthorizationContext } from "../../authorization"
import { assertCanAppendTelemetry } from "../../authorization"
import type { TelemetryCommitResult, TelemetryPointWrite } from "../../materialization/model"
import { getOntologyMutationRuntime } from "../../runtime/ontology-mutations"
import type { RuntimeMaterializerContext } from "../materializer-adapter"

export type TelemetryWriteContext = RuntimeMaterializerContext & {
  readonly authorization?: AuthorizationContext
}

export async function writeTelemetryBatch(
  ctx: TelemetryWriteContext,
  points: readonly TelemetryPointWrite[]
): Promise<TelemetryCommitResult | null> {
  // Asserted from the points rather than a resolved context: this leaf is the low-level choke point
  // for both `appendTelemetryBatch` and the per-property `TelemetryChannel`, and only the points know
  // which object types the call actually touches.
  for (const objectTypeId of new Set(points.map((point) => point.series.object.objectTypeId))) {
    assertCanAppendTelemetry(ctx, objectTypeId)
  }
  if (points.length === 0) return null

  // A missing telemetry target propagates as-is: the Materializer already reports it as
  // `storage.object_not_found` with the object in `details`, which is the 404 this call owes its
  // caller. Rewrapping it here only restated the same failure in different words.
  return await getOntologyMutationRuntime(ctx).appendTelemetry({
    source: { kind: "runtime", requestId: randomUUID() },
    // A `Principal` is an `EventActor` — same literals, no translation.
    ...(ctx.authorization === undefined ? {} : { actor: ctx.authorization.principal }),
    points,
  })
}
