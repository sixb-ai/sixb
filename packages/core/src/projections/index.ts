// ── Builders ─────────────────────────────────────────────────
export {
  categorizeProjections,
  defineLinkProjection,
  defineProjection,
  fromForeignKey,
  isLinkProjectionDefinition,
  isObjectProjectionDefinition,
  isProjectionDefinition,
} from "./builders"
// ── Errors ──────────────────────────────────────────────────
export { ProjectionValidationError } from "./errors"
// ── Types ────────────────────────────────────────────────────
export type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
} from "./types"
// ── Validation ───────────────────────────────────────────────
export { validateProjectionsAtStartup } from "./validation"
