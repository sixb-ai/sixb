// ── Builders ─────────────────────────────────────────────────

export {
  categorizeProjections,
  defineProjection,
  fromForeignKey,
  isLinkProjectionDefinition,
  isObjectProjectionDefinition,
  isProjectionDefinition,
  isTelemetryProjectionDefinition,
  projectionKindOf,
} from "./builders"
// ── Errors ──────────────────────────────────────────────────
// ── Types ────────────────────────────────────────────────────
export type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  LinkProjectionTarget,
  ObjectProjectionDefinition,
  ObjectProjectionTarget,
  ProjectionDefinition,
  ProjectionKind,
  ProjectionTarget,
  ProjectionTargetByKind,
  TelemetryProjectionDefinition,
} from "./types"
// ── Validation ───────────────────────────────────────────────
export {
  validateProjectionsAtStartup,
  validateTelemetryProjectionFieldMapping,
} from "./validation"
