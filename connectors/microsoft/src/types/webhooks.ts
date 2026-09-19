import type { WebhookHandlerContext } from "@sixb/core"
import type { MicrosoftClient } from "../client"
import type { SubscriptionChangeType } from "./subscriptions"

interface MicrosoftNotificationBase {
  readonly subscriptionId: string
  readonly subscriptionExpirationDateTime?: string
  readonly tenantId: string
}

export interface MicrosoftChangeEvent extends MicrosoftNotificationBase {
  readonly kind: "change"
  readonly changeType: SubscriptionChangeType
  readonly resource: string
  readonly resourceData?: {
    readonly id?: string
    readonly "@odata.type"?: string
    readonly "@odata.id"?: string
    readonly "@odata.etag"?: string
  }
}

export interface MicrosoftLifecycleEvent extends MicrosoftNotificationBase {
  readonly kind: "lifecycle"
  readonly lifecycleEvent: "reauthorizationRequired" | "subscriptionRemoved" | "missed"
}

export type MicrosoftWebhookEvent = MicrosoftChangeEvent | MicrosoftLifecycleEvent

export interface MicrosoftEventContext
  extends Pick<WebhookHandlerContext<unknown, MicrosoftClient>, "sixb" | "logger" | "client"> {
  readonly event: MicrosoftWebhookEvent
}

export type MicrosoftEventHandler = (context: MicrosoftEventContext) => void | Promise<void>
