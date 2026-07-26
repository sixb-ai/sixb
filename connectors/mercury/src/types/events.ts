import type { Logger, OntologySource, Sixb } from "@sixb/core"
import type { MercuryClient } from "./client"
import type { MercuryCursorOptions, MercuryPageCursors, MercuryTimestamp } from "./common"

export type MercuryEventOperationType = "create" | "update" | "delete"

export type MercuryEventResourceType =
  | "transaction"
  | "checkingAccount"
  | "savingsAccount"
  | "treasuryAccount"
  | "investmentAccount"
  | "creditAccount"

/**
 * One entry in Mercury's audit stream. Changes are expressed as a JSON Merge Patch
 * ([RFC 7396](https://datatracker.ietf.org/doc/html/rfc7396)): `mergePatch` holds the new values
 * for the changed fields and `previousValues` holds what they were.
 *
 * The same shape arrives on inbound webhook deliveries, so one handler can serve both the
 * polling and push paths.
 */
export interface MercuryEvent {
  readonly id: string
  readonly resourceType: MercuryEventResourceType
  readonly resourceId: string
  readonly operationType: MercuryEventOperationType
  /** Version of the resource after this change, starting at 1. */
  readonly resourceVersion: number
  readonly occurredAt: MercuryTimestamp
  /** JSON paths that changed, e.g. `["status", "postedAt"]`. */
  readonly changedPaths: readonly string[]
  readonly mergePatch: Readonly<Record<string, unknown>>
  readonly previousValues?: Readonly<Record<string, unknown>> | null
}

export interface MercuryEventsResponse {
  readonly events: readonly MercuryEvent[]
  readonly page: MercuryPageCursors
}

export interface MercuryEventListOptions extends MercuryCursorOptions {
  readonly resourceType?: MercuryEventResourceType
  readonly resourceId?: string
}

/** Context passed to the connector's `onEvent` handler for each inbound webhook delivery. */
export interface MercuryEventContext {
  readonly event: MercuryEvent
  readonly request: Request
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  /** Resolves the Mercury client lazily, only if the handler needs to read back. */
  client(): Promise<MercuryClient>
}

export type MercuryEventHandler = (context: MercuryEventContext) => Promise<void> | void
