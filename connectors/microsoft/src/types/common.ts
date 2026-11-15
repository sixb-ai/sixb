import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { MicrosoftAuthOptions, MicrosoftOAuthOptions } from "../auth/types"
import type { MicrosoftEventHandler, MicrosoftOAuthEventHandler } from "./webhooks"

export interface MicrosoftConnectorOptions {
  readonly auth: MicrosoftAuthOptions
  /** Per HTTP attempt, including auth and media. Defaults to 30 seconds. */
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  /** Read retries only. Mutations are never automatically replayed. */
  readonly retry?: RestRetryPolicy
  /**
   * Secret behind every subscription's Graph clientState, at most 128 characters. Required for
   * subscriptions and onEvent. Application connections send it as is; a person's connection sends
   * a value signed with it that names their account.
   */
  readonly webhookSecret?: string
  /** Runs inside Sixb's webhook execution. Persist/enqueue work before returning. */
  readonly onEvent?: MicrosoftEventHandler
}

/** Connections people make with their own accounts. */
export interface MicrosoftOAuthConnectorOptions
  extends Omit<MicrosoftConnectorOptions, "auth" | "onEvent"> {
  readonly auth: { readonly oauth: MicrosoftOAuthOptions }
  /**
   * Runs inside Sixb's webhook execution with the connections of the person whose subscription
   * sent the notification. Persist/enqueue work before returning.
   */
  readonly onEvent?: MicrosoftOAuthEventHandler
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
