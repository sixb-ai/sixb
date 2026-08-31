// ── Builders ─────────────────────────────────────────────────

export type {
  ObjectProjectionBuilder,
  ObjectProjectionConflictResolution,
  ProjectionForeignKeyInput,
} from "./builders"
export {
  categorizeProjections,
  defineProjection,
  fromForeignKey,
  isLinkProjectionDefinition,
  isObjectProjectionDefinition,
  isProjectionDefinition,
  isTelemetryProjectionDefinition,
} from "./builders"
// ── Errors ──────────────────────────────────────────────────
export { ProjectionValidationError } from "./errors"
export type { ProjectionDefinitionCatalog, ProjectionRegistryOptions } from "./registry"
export { ProjectionRegistry } from "./registry"
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
  SourceEditConflictResolution,
  TelemetryProjectionDefinition,
  TelemetryProjectionPropertyMapping,
} from "./types"
// ── Validation ───────────────────────────────────────────────
export {
  validateProjectionsAtStartup,
  validateTelemetryProjectionFieldMapping,
} from "./validation"
