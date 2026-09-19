import type { RequestOptions } from "./common"

export type SubscriptionChangeType = "created" | "updated" | "deleted"
export type SubscriptionChangeTypes =
  | SubscriptionChangeType
  | `${SubscriptionChangeType},${SubscriptionChangeType}`
  | `${SubscriptionChangeType},${SubscriptionChangeType},${SubscriptionChangeType}`

/** Basic HTTPS notifications. Encrypted resource data and Web Push are not supported. */
export interface SubscriptionCreate {
  readonly resource: string
  readonly changeType: SubscriptionChangeTypes
  readonly notificationUrl: string
  /** Future UTC timestamp. Graph enforces the resource-specific maximum lifetime. */
  readonly expirationDateTime: string
  /** Secret echoed in notifications; at most 128 characters. Never log it. */
  readonly clientState?: string
  readonly lifecycleNotificationUrl?: string
  readonly latestSupportedTlsVersion?: "v1_0" | "v1_1" | "v1_2" | "v1_3"
  readonly notificationUrlAppId?: string
  readonly includeResourceData?: false
}

/** Only these two fields can be changed after creation. */
export type SubscriptionUpdate =
  | { readonly expirationDateTime: string; readonly notificationUrl?: string }
  | { readonly expirationDateTime?: string; readonly notificationUrl: string }

export interface SubscriptionCreateOptions extends RequestOptions {
  /** Use the same ID format as the connector's Outlook mail/calendar APIs. */
  readonly immutableIds?: boolean
}

/** Fields may be omitted by Graph, including when using $select. Treat clientState as a secret. */
export interface Subscription {
  readonly id: string
  readonly resource?: string
  readonly changeType?: string
  readonly notificationUrl?: string
  readonly expirationDateTime?: string
  readonly clientState?: string
  readonly lifecycleNotificationUrl?: string
  readonly applicationId?: string
  readonly creatorId?: string
  readonly latestSupportedTlsVersion?: string
  readonly notificationUrlAppId?: string
  readonly includeResourceData?: boolean
  readonly encryptionCertificate?: string
  readonly encryptionCertificateId?: string
  readonly notificationQueryOptions?: string
}
