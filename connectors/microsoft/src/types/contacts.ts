import type { GraphPage, ListOptions, RequestOptions, SelectOptions } from "./common"
import type { MailSubscribeOptions } from "./subscriptions"

export interface ContactEmailAddress {
  readonly address?: string | null
  readonly name?: string | null
}
export interface ContactPhysicalAddress {
  readonly street?: string | null
  readonly city?: string | null
  readonly state?: string | null
  readonly postalCode?: string | null
  /** Free-format, for example "United States". */
  readonly countryOrRegion?: string | null
}
/** `id` follows Outlook's extended property formats, for example `String {guid} Name crmId`. */
export interface SingleValueExtendedProperty {
  readonly id: string
  readonly value: string
}
export interface MultiValueExtendedProperty {
  readonly id: string
  readonly value: readonly string[]
}
export type OpenExtensionValue = string | number | boolean | readonly (string | number | boolean)[]
/** An open extension as Graph returns it: `id` is the fully qualified extension name. */
export interface ContactExtension {
  readonly id: string
  readonly "@odata.type"?: string
  readonly extensionName?: string
  readonly [property: string]: unknown
}
/** Custom data stored under `extensionName`; values are primitives or arrays of primitives. */
export interface ContactExtensionInput {
  readonly extensionName: string
  readonly [property: string]: OpenExtensionValue
}
export interface ContactPhoto {
  /** Size label such as `240x240`. */
  readonly id: string
  readonly height?: number | null
  readonly width?: number | null
  readonly "@odata.mediaContentType"?: string
  readonly "@odata.mediaEtag"?: string
}
/** Wire properties can be absent in projections and delta responses. */
export interface Contact {
  readonly id: string
  readonly assistantName?: string | null
  /** DateTimeOffset, for example `1974-07-22T00:00:00Z`. */
  readonly birthday?: string | null
  readonly businessAddress?: ContactPhysicalAddress | null
  readonly businessHomePage?: string | null
  readonly businessPhones?: readonly string[] | null
  readonly categories?: readonly string[] | null
  readonly changeKey?: string | null
  readonly children?: readonly string[] | null
  readonly companyName?: string | null
  readonly createdDateTime?: string | null
  readonly department?: string | null
  readonly displayName?: string | null
  readonly emailAddresses?: readonly ContactEmailAddress[] | null
  readonly fileAs?: string | null
  /** The name suffix, for example "Jr.". */
  readonly generation?: string | null
  readonly givenName?: string | null
  readonly homeAddress?: ContactPhysicalAddress | null
  readonly homePhones?: readonly string[] | null
  readonly imAddresses?: readonly string[] | null
  readonly initials?: string | null
  readonly jobTitle?: string | null
  readonly lastModifiedDateTime?: string | null
  /** The manager's name; Outlook stores it as text, not as a directory link. */
  readonly manager?: string | null
  readonly middleName?: string | null
  readonly mobilePhone?: string | null
  readonly nickName?: string | null
  readonly officeLocation?: string | null
  readonly otherAddress?: ContactPhysicalAddress | null
  readonly parentFolderId?: string | null
  readonly personalNotes?: string | null
  readonly primaryEmailAddress?: ContactEmailAddress | null
  readonly profession?: string | null
  readonly secondaryEmailAddress?: ContactEmailAddress | null
  readonly spouseName?: string | null
  readonly surname?: string | null
  readonly tertiaryEmailAddress?: ContactEmailAddress | null
  readonly title?: string | null
  readonly yomiCompanyName?: string | null
  readonly yomiGivenName?: string | null
  readonly yomiSurname?: string | null
  /** Present only when requested with `expand`. */
  readonly photo?: ContactPhoto | null
  readonly extensions?: readonly ContactExtension[] | null
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[] | null
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[] | null
}
/**
 * Graph's writable contact properties. Structured addresses are replaced as a whole: pass every
 * field you want to keep. Changing other names can regenerate `displayName`; include it to keep it.
 * Graph's update table also lists `parentFolderId`, but documents no move semantics for contacts;
 * it stays out until a live tenant confirms what it does.
 */
export interface ContactUpdate {
  readonly assistantName?: string | null
  readonly birthday?: string | null
  readonly businessAddress?: ContactPhysicalAddress
  readonly businessHomePage?: string | null
  readonly businessPhones?: readonly string[]
  readonly categories?: readonly string[]
  readonly children?: readonly string[]
  readonly companyName?: string | null
  readonly department?: string | null
  readonly displayName?: string | null
  readonly emailAddresses?: readonly ContactEmailAddress[]
  readonly fileAs?: string | null
  readonly generation?: string | null
  readonly givenName?: string | null
  readonly homeAddress?: ContactPhysicalAddress
  readonly homePhones?: readonly string[]
  readonly imAddresses?: readonly string[]
  readonly initials?: string | null
  readonly jobTitle?: string | null
  readonly manager?: string | null
  readonly middleName?: string | null
  readonly mobilePhone?: string | null
  readonly nickName?: string | null
  readonly officeLocation?: string | null
  readonly otherAddress?: ContactPhysicalAddress
  readonly personalNotes?: string | null
  readonly primaryEmailAddress?: ContactEmailAddress
  readonly profession?: string | null
  readonly secondaryEmailAddress?: ContactEmailAddress
  readonly spouseName?: string | null
  readonly surname?: string | null
  readonly tertiaryEmailAddress?: ContactEmailAddress
  readonly title?: string | null
  readonly yomiCompanyName?: string | null
  readonly yomiGivenName?: string | null
  readonly yomiSurname?: string | null
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[]
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[]
}
export interface ContactInput extends ContactUpdate {
  /** Open extensions can be created with the contact; change them later with `contacts.extensions`. */
  readonly extensions?: readonly ContactExtensionInput[]
}
export interface ContactFolder {
  readonly id: string
  readonly displayName?: string | null
  readonly parentFolderId?: string | null
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[] | null
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[] | null
}
/** At least one field. A new `parentFolderId` moves the folder. */
export interface ContactFolderUpdate {
  readonly displayName?: string
  readonly parentFolderId?: string
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[]
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[]
}
export interface ContactFolderCreateOptions extends RequestOptions {
  /** Omit to create under the default Contacts folder. */
  readonly parentId?: string
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[]
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[]
}
export interface ContactFolderOptions extends RequestOptions {
  /** Omit for the default Contacts folder. */
  readonly folderId?: string
}
export interface ContactGetOptions extends SelectOptions {
  readonly folderId?: string
}
export interface ContactListOptions extends ListOptions {
  readonly folderId?: string
  readonly filter?: string
  /** Exact match on any of the contact's addresses; cannot be combined with `filter`. */
  readonly email?: string
}
export interface ContactFolderListOptions extends ListOptions {
  readonly filter?: string
}
export interface ContactDeltaOptions extends RequestOptions {
  /** Opaque checkpoint; persist together with its tenant, mailbox and folder. */
  readonly cursor?: string
  readonly select?: readonly string[]
  readonly pageSize?: number
}
export type ContactDeltaItem<T> = T & {
  /** A contact can be removed from a folder by a move as well as by deletion. */
  readonly "@removed"?: { readonly reason?: string }
}
export interface ContactDeltaPage<T> extends GraphPage<ContactDeltaItem<T>> {
  readonly "@odata.deltaLink"?: string
}
/** Watches every personal contact in the mailbox; Graph has no folder-scoped contact resource. */
export type ContactSubscribeOptions = Omit<MailSubscribeOptions, "folderId">
