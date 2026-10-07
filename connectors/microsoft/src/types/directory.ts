import type { GraphPage, ListOptions, RequestOptions } from "./common"

/** A user, group, contact or other Entra object; `@odata.type` says which. */
export interface DirectoryObject {
  readonly id: string
  readonly "@odata.type"?: string
  readonly deletedDateTime?: string | null
  readonly [property: string]: unknown
}
export interface PhysicalOfficeAddress {
  readonly street?: string | null
  readonly city?: string | null
  readonly state?: string | null
  readonly postalCode?: string | null
  readonly countryOrRegion?: string | null
  /** Building and office number. */
  readonly officeLocation?: string | null
}
export type DirectoryPhoneType =
  | "home"
  | "business"
  | "mobile"
  | "other"
  | "assistant"
  | "homeFax"
  | "businessFax"
  | "otherFax"
  | "pager"
  | "radio"
export interface DirectoryPhone {
  readonly number?: string | null
  readonly type?: DirectoryPhoneType | null
}
export interface OnPremisesProvisioningError {
  readonly category?: string | null
  readonly occurredDateTime?: string | null
  readonly propertyCausingError?: string | null
  readonly value?: string | null
}
export interface ServiceProvisioningError {
  readonly "@odata.type"?: string
  readonly createdDateTime?: string | null
  readonly isResolved?: boolean | null
  readonly serviceInstance?: string | null
  /** XML published by the service, on `#microsoft.graph.serviceProvisioningXmlError`. */
  readonly errorDetail?: string | null
}
/**
 * An organizational contact: an external address managed by administrators and listed in the
 * company address book. Read-only in Graph; it is created in Exchange Online or synchronized
 * from an on-premises directory.
 */
export interface OrgContact {
  readonly id: string
  readonly deletedDateTime?: string | null
  /** Graph currently keeps at most one address per organizational contact. */
  readonly addresses?: readonly PhysicalOfficeAddress[] | null
  readonly companyName?: string | null
  readonly department?: string | null
  readonly displayName?: string | null
  readonly givenName?: string | null
  /** Returned by Graph although its v1.0 property table omits it. */
  readonly imAddresses?: readonly string[] | null
  readonly jobTitle?: string | null
  readonly mail?: string | null
  readonly mailNickname?: string | null
  readonly onPremisesLastSyncDateTime?: string | null
  readonly onPremisesProvisioningErrors?: readonly OnPremisesProvisioningError[] | null
  /** `false`: once synchronized, now mastered in Exchange. `null`: never synchronized. */
  readonly onPremisesSyncEnabled?: boolean | null
  /** At most one phone of each type. */
  readonly phones?: readonly DirectoryPhone[] | null
  /** For example `SMTP:bob@contoso.com` (primary) and `smtp:bob@sales.contoso.com`. */
  readonly proxyAddresses?: readonly string[] | null
  readonly serviceProvisioningErrors?: readonly ServiceProvisioningError[] | null
  readonly surname?: string | null
  /** Present only when requested with `expand`. */
  readonly manager?: DirectoryObject | null
  readonly directReports?: readonly DirectoryObject[] | null
  readonly memberOf?: readonly DirectoryObject[] | null
}
export interface DirectoryQueryOptions extends ListOptions {
  readonly filter?: string
  /**
   * Graph syntax, for example `"displayName:acme"`. Turns on `ConsistencyLevel: eventual`, which
   * Graph does not combine with `expand`.
   */
  readonly search?: string
  /**
   * Sends `ConsistencyLevel: eventual` and `$count=true`. Graph requires both for some filters
   * (for example `ne` or `null` checks) and for `filter` combined with `orderBy`. Results can lag
   * recent changes.
   */
  readonly advancedQuery?: boolean
}
export interface DirectoryPage<T> extends GraphPage<T> {
  /** Present when `advancedQuery` requested a count. */
  readonly "@odata.count"?: number
}
export interface OrgContactDeltaOptions extends RequestOptions {
  /** Opaque checkpoint. Directory delta checkpoints expire after seven days. */
  readonly cursor?: string
  readonly select?: readonly string[]
  /** Track only these contacts (1–50). */
  readonly ids?: readonly string[]
  /**
   * Skip the initial enumeration and return a checkpoint for changes from now on. Graph documents
   * this for Entra resources such as users and groups; its orgContact page does not list it.
   */
  readonly latest?: boolean
  /** Return only changed properties on rounds after the first. Can be set on any request. */
  readonly minimal?: boolean
}
export type DirectoryDeltaItem<T> = T & {
  /** `changed`: deleted but restorable from deleted items. `deleted`: permanently deleted. */
  readonly "@removed"?: { readonly reason?: "changed" | "deleted" | (string & {}) }
}
export interface DirectoryDeltaPage<T> extends GraphPage<DirectoryDeltaItem<T>> {
  readonly "@odata.deltaLink"?: string
}
