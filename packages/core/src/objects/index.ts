/**
 * Object operations module.
 *
 * Provides context types, leaf functions, a service layer for
 * resolving objectTypeId-based calls to fully-typed operations,
 * and SDK adapters (ObjectSet / ObjectByIdHandle) for the typed API.
 */

// Leaf functions
export { requestAction } from "./action"
// Context types + factories
export type {
  ResolvedLinkBatchItem,
  ResolvedLinkContext,
  ResolvedObjectContext,
} from "./context"
export { requireLinkDefinition, resolveLinkContext, resolveObjectContext } from "./context"
export { ObjectError } from "./errors"
export { removeLink, setLinkBatch, upsertLink, upsertLinkBatch } from "./link"
export { deleteObject, restoreObject, upsertObject, upsertObjectBatch } from "./object"
// SDK adapters (typed ObjectSet / ObjectByIdHandle)
export { createObjectSet } from "./sdk"
// Service layer (resolve objectTypeId → delegate to leaf)
export * as objectService from "./service"
export type { TelemetryHistoryOptions } from "./telemetry"
export { appendTelemetryBatch, getTelemetryHistoryBatch, writeTelemetryBatch } from "./telemetry"
