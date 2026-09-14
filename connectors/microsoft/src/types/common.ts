import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { MicrosoftAuthOptions } from "../auth/types"

export interface MicrosoftConnectorOptions {
  readonly auth: MicrosoftAuthOptions
  /** Per HTTP attempt, including auth and media. Defaults to 30 seconds. */
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  /** Read retries only. Mutations are never automatically replayed. */
  readonly retry?: RestRetryPolicy
}

export interface RequestOptions {
  readonly signal?: AbortSignal
}

export interface SelectOptions extends RequestOptions {
  readonly select?: readonly string[]
  readonly expand?: string
}

export interface ListOptions extends SelectOptions {
  readonly top?: number
  readonly orderBy?: string
}

export interface WriteOptions extends RequestOptions {
  /** Protect a mutation against concurrent modifications (412 on mismatch). */
  readonly ifMatch?: string
}

export type ConflictBehavior = "fail" | "replace" | "rename"

export interface GraphPage<T> {
  readonly value: readonly T[]
  readonly "@odata.nextLink"?: string
  readonly "@odata.context"?: string
}

export interface Identity {
  readonly id?: string
  readonly displayName?: string
  readonly email?: string
}

export interface IdentitySet {
  readonly user?: Identity
  readonly application?: Identity
  readonly group?: Identity
  readonly siteUser?: Identity & { readonly loginName?: string }
}
