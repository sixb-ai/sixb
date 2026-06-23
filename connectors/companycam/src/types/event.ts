import type { OntologySource, Sixb } from "@sixb/core"
import type { CompanyCamClient } from "../client"
import type { CompanyCamEventType } from "./webhook"

/**
 * Envelope for an inbound CompanyCam webhook delivery
 * (`{ event_type, created_at, payload, webhook_id }`).
 *
 * Narrow on `type` (e.g. `"project.created"`), then cast `payload` to the
 * matching resource type (`CompanyCamProject`, `CompanyCamPhoto`, …).
 */
export interface CompanyCamWebhookEvent {
  readonly type: CompanyCamEventType
  /** Unix epoch seconds. */
  readonly createdAt: number
  readonly webhookId: number
  readonly payload: Record<string, unknown>
}

/**
 * Context passed to `onEvent` for each verified delivery.
 *
 * `sixb` is the live runtime — use it to upsert objects, append telemetry, etc.
 * `client()` lazily resolves the CompanyCam client so the handler can call back.
 */
export interface CompanyCamEventContext {
  readonly event: CompanyCamWebhookEvent
  readonly sixb: Sixb<readonly OntologySource[]>
  client(): Promise<CompanyCamClient>
}

export type CompanyCamEventHandler = (context: CompanyCamEventContext) => Promise<void> | void
