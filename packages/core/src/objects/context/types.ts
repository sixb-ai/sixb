/**
 * Resolved context types for object operations.
 *
 * Context hierarchy: SixbRuntimeContext → ResolvedObjectContext → ResolvedLinkContext
 */

import type { BlobStorage } from "../../blob-storage"
import type { ExecutionContext } from "../../execution"
import type { ObjectLink } from "../../ontology"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type { SixbRuntimeContext } from "../../runtime/types"

/** Resolved context for object operations — extends runtime with resolved type info. */
export interface ResolvedObjectContext extends SixbRuntimeContext {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly primaryPropertyId: string
}

/** Object operations bound to one immutable execution. */
export interface ExecutionObjectContext extends ResolvedObjectContext {
  readonly execution: ExecutionContext
}

/** An object set's operations, which also open the files its objects reference. */
export interface ObjectSetContext extends ExecutionObjectContext {
  /** Opened only once a FileRef is resolved in a row read with the caller's permissions. */
  readonly blobStorage: Pick<BlobStorage, "stat" | "open">
}

/** Resolved context for link operations. */
export interface ResolvedLinkContext extends ResolvedObjectContext {
  readonly linkDefinition: ObjectLink
}

/** Pre-resolved data for a single item in a link batch operation. */
export interface ResolvedLinkBatchItem {
  readonly objectType: ObjectTypeWithPropertyTokens
  readonly linkDefinition: ObjectLink
  readonly sourceId: string
  readonly linkId: string
  readonly targetTypeId: string
  readonly targetId: string
  readonly properties?: Record<string, unknown>
}
