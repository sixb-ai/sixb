/**
 * Hand-written types for the Google Calendar API v3. As with the Drive types,
 * every resource carries an open index signature: Calendar's `fields` selector
 * returns partial resources and Google adds fields over time, so we surface
 * whatever comes back rather than pretending to model the whole schema.
 *
 * `*Options` types intersect `QueryParams` so they pass straight to the HTTP
 * layer as query strings without casts (the pipedrive idiom). Because
 * `QueryParams` has an index signature, callers can always pass query params
 * beyond the named ones; the named fields exist for discoverability.
 */
import type { QueryParams } from "./common"

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** A point in time, either an all-day `date` or a `dateTime` with a zone. */
export interface EventDateTime {
  readonly date?: string
  readonly dateTime?: string
  readonly timeZone?: string
  readonly [key: string]: unknown
}

export interface EventReminderOverride {
  readonly method?: string
  readonly minutes?: number
}

export interface EventReminders {
  readonly useDefault?: boolean
  readonly overrides?: readonly EventReminderOverride[]
}

export interface CalendarNotification {
  readonly type?: string
  readonly method?: string
}

export interface ConferenceProperties {
  readonly allowedConferenceSolutionTypes?: readonly CalendarConferenceSolutionType[]
  readonly [key: string]: unknown
}

/** A busy interval / free-busy period. */
export interface TimePeriod {
  readonly start: string
  readonly end: string
}

// ---------------------------------------------------------------------------
// Channels (push notifications) — shared by every `watch` method and `stop`.
// ---------------------------------------------------------------------------

export interface Channel {
  /** A UUID (or similar) identifying the channel. Required. */
  readonly id: string
  /** Delivery mechanism, typically `"web_hook"`. */
  readonly type?: string
  /** HTTPS webhook endpoint that receives notifications. */
  readonly address?: string
  /** Opaque value echoed back on each notification. */
  readonly token?: string
  /** Expiration as a Unix timestamp in milliseconds (string). */
  readonly expiration?: string
  /** Additional parameters, e.g. `{ ttl: "3600" }`. */
  readonly params?: Readonly<Record<string, string>>
  /** Opaque id of the watched resource (present on responses / required by `stop`). */
  readonly resourceId?: string
  /** Version-specific identifier of the watched resource (response). */
  readonly resourceUri?: string
  readonly kind?: string
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventPerson {
  readonly id?: string
  readonly email?: string
  readonly displayName?: string
  readonly self?: boolean
  readonly [key: string]: unknown
}

export interface EventAttendee {
  readonly id?: string
  readonly email?: string
  readonly displayName?: string
  readonly organizer?: boolean
  readonly self?: boolean
  readonly resource?: boolean
  readonly optional?: boolean
  /** One of `needsAction`, `declined`, `tentative`, `accepted`. */
  readonly responseStatus?: string
  readonly comment?: string
  readonly additionalGuests?: number
  readonly [key: string]: unknown
}

export type CalendarConferenceSolutionType =
  | "eventHangout"
  | "eventNamedHangout"
  | "hangoutsMeet"
  | "addOn"
  | (string & {})

export type CalendarConferenceRequestStatusCode = "pending" | "success" | "failure" | (string & {})

export type CalendarConferenceEntryPointType = "video" | "phone" | "sip" | "more" | (string & {})

export interface ConferenceSolutionKey {
  readonly type?: CalendarConferenceSolutionType
  readonly [key: string]: unknown
}

export interface ConferenceSolution {
  readonly key?: ConferenceSolutionKey
  readonly name?: string
  readonly iconUri?: string
  readonly [key: string]: unknown
}

export interface ConferenceRequestStatus {
  readonly statusCode?: CalendarConferenceRequestStatusCode
  readonly [key: string]: unknown
}

export interface CreateConferenceRequest {
  /** Client-generated idempotency key; generate a new value for every new conference request. */
  readonly requestId: string
  readonly conferenceSolutionKey?: ConferenceSolutionKey
  readonly status?: ConferenceRequestStatus
  readonly [key: string]: unknown
}

export interface ConferenceEntryPoint {
  readonly entryPointType?: CalendarConferenceEntryPointType
  readonly uri?: string
  readonly label?: string
  readonly meetingCode?: string
  readonly accessCode?: string
  readonly passcode?: string
  readonly password?: string
  readonly pin?: string
  readonly regionCode?: string
  readonly entryPointFeatures?: readonly string[]
  readonly [key: string]: unknown
}

export interface ConferenceParametersAddOnParameters {
  readonly parameters?: Readonly<Record<string, string>>
  readonly [key: string]: unknown
}

export interface ConferenceParameters {
  readonly addOnParameters?: ConferenceParametersAddOnParameters
  readonly [key: string]: unknown
}

export interface ConferenceData {
  /** For Google Meet, this is the meeting code such as `abc-mnop-xyz`. */
  readonly conferenceId?: string
  readonly conferenceSolution?: ConferenceSolution
  readonly createRequest?: CreateConferenceRequest
  readonly entryPoints?: readonly ConferenceEntryPoint[]
  readonly parameters?: ConferenceParameters
  readonly notes?: string
  readonly signature?: string
  readonly [key: string]: unknown
}

export interface EventAttachment {
  readonly fileId?: string
  readonly fileUrl?: string
  readonly title?: string
  readonly mimeType?: string
  readonly iconLink?: string
  readonly [key: string]: unknown
}

export interface EventExtendedProperties {
  readonly private?: Readonly<Record<string, string>>
  readonly shared?: Readonly<Record<string, string>>
}

export interface EventSource {
  readonly url?: string
  readonly title?: string
}

export interface Event {
  readonly id?: string
  readonly kind?: string
  readonly etag?: string
  /** One of `confirmed`, `tentative`, `cancelled`. */
  readonly status?: string
  readonly summary?: string
  readonly description?: string
  readonly location?: string
  readonly colorId?: string
  readonly start?: EventDateTime
  readonly end?: EventDateTime
  readonly endTimeUnspecified?: boolean
  /** RFC 5545 lines: `RRULE`, `EXRULE`, `RDATE`, `EXDATE`. */
  readonly recurrence?: readonly string[]
  readonly recurringEventId?: string
  readonly originalStartTime?: EventDateTime
  readonly creator?: EventPerson
  readonly organizer?: EventPerson
  readonly attendees?: readonly EventAttendee[]
  readonly attendeesOmitted?: boolean
  readonly conferenceData?: ConferenceData
  readonly hangoutLink?: string
  readonly reminders?: EventReminders
  readonly attachments?: readonly EventAttachment[]
  readonly extendedProperties?: EventExtendedProperties
  readonly source?: EventSource
  /** One of `default`, `birthday`, `focusTime`, `outOfOffice`, `workingLocation`, `fromGmail`. */
  readonly eventType?: string
  readonly visibility?: string
  readonly transparency?: string
  readonly guestsCanInviteOthers?: boolean
  readonly guestsCanModify?: boolean
  readonly guestsCanSeeOtherGuests?: boolean
  readonly iCalUID?: string
  readonly sequence?: number
  readonly created?: string
  readonly updated?: string
  readonly htmlLink?: string
  readonly [key: string]: unknown
}

export interface EventList {
  readonly kind?: string
  readonly etag?: string
  readonly summary?: string
  readonly description?: string
  readonly updated?: string
  readonly timeZone?: string
  readonly accessRole?: string
  readonly defaultReminders?: readonly EventReminderOverride[]
  readonly nextPageToken?: string
  /** Present on the final page — persist it to poll incrementally with `syncToken`. */
  readonly nextSyncToken?: string
  readonly items?: readonly Event[]
}

export type EventsListOptions = QueryParams & {
  readonly iCalUID?: string
  readonly maxAttendees?: number
  readonly maxResults?: number
  /** `startTime` or `updated`. */
  readonly orderBy?: string
  readonly pageToken?: string
  readonly privateExtendedProperty?: string
  readonly q?: string
  readonly sharedExtendedProperty?: string
  readonly showDeleted?: boolean
  readonly showHiddenInvitations?: boolean
  readonly singleEvents?: boolean
  readonly syncToken?: string
  readonly timeMax?: string
  readonly timeMin?: string
  readonly timeZone?: string
  readonly updatedMin?: string
  readonly eventTypes?: string
}

export type EventGetOptions = QueryParams & {
  readonly maxAttendees?: number
  readonly timeZone?: string
  readonly alwaysIncludeEmail?: boolean
}

export type EventWriteOptions = QueryParams & {
  readonly conferenceDataVersion?: 0 | 1
  readonly maxAttendees?: number
  readonly supportsAttachments?: boolean
  /** `all`, `externalOnly`, or `none`. Prefer this over `sendNotifications`. */
  readonly sendUpdates?: string
  readonly sendNotifications?: boolean
}

export type EventDeleteOptions = QueryParams & {
  readonly sendUpdates?: string
  readonly sendNotifications?: boolean
}

export type EventImportOptions = QueryParams & {
  readonly conferenceDataVersion?: 0 | 1
  readonly supportsAttachments?: boolean
}

export type EventInstancesOptions = QueryParams & {
  readonly maxAttendees?: number
  readonly maxResults?: number
  readonly pageToken?: string
  readonly showDeleted?: boolean
  readonly timeMax?: string
  readonly timeMin?: string
  readonly timeZone?: string
  readonly originalStart?: string
  readonly alwaysIncludeEmail?: boolean
}

export type EventMoveOptions = QueryParams & {
  /** Calendar id to move the event to. Required. */
  readonly destination: string
  readonly sendUpdates?: string
  readonly sendNotifications?: boolean
}

export type EventQuickAddOptions = QueryParams & {
  /** Free-form text describing the event. Required. */
  readonly text: string
  readonly sendUpdates?: string
  readonly sendNotifications?: boolean
}

export type EventsWatchOptions = EventsListOptions

// ---------------------------------------------------------------------------
// Calendars (calendar metadata)
// ---------------------------------------------------------------------------

export interface Calendar {
  readonly id?: string
  readonly kind?: string
  readonly etag?: string
  readonly summary?: string
  readonly description?: string
  readonly location?: string
  readonly timeZone?: string
  readonly conferenceProperties?: ConferenceProperties
  readonly [key: string]: unknown
}

// ---------------------------------------------------------------------------
// CalendarList (the authenticated user's list of calendars)
// ---------------------------------------------------------------------------

export interface CalendarListEntry {
  readonly id?: string
  readonly kind?: string
  readonly etag?: string
  readonly summary?: string
  readonly summaryOverride?: string
  readonly description?: string
  readonly location?: string
  readonly timeZone?: string
  readonly colorId?: string
  readonly backgroundColor?: string
  readonly foregroundColor?: string
  readonly hidden?: boolean
  readonly selected?: boolean
  /** `freeBusyReader`, `reader`, `writer`, or `owner`. */
  readonly accessRole?: string
  readonly defaultReminders?: readonly EventReminderOverride[]
  readonly notificationSettings?: { readonly notifications?: readonly CalendarNotification[] }
  readonly primary?: boolean
  readonly deleted?: boolean
  readonly conferenceProperties?: ConferenceProperties
  readonly [key: string]: unknown
}

export interface CalendarList {
  readonly kind?: string
  readonly etag?: string
  readonly nextPageToken?: string
  readonly nextSyncToken?: string
  readonly items?: readonly CalendarListEntry[]
}

export type CalendarListListOptions = QueryParams & {
  readonly maxResults?: number
  readonly minAccessRole?: string
  readonly pageToken?: string
  readonly showDeleted?: boolean
  readonly showHidden?: boolean
  readonly syncToken?: string
}

export type CalendarListGetOptions = QueryParams

export type CalendarListInsertOptions = QueryParams & {
  readonly colorRgbFormat?: boolean
}

export type CalendarListUpdateOptions = QueryParams & {
  readonly colorRgbFormat?: boolean
}

export type CalendarListWatchOptions = CalendarListListOptions

// ---------------------------------------------------------------------------
// Acl (access control rules per calendar)
// ---------------------------------------------------------------------------

export interface AclScope {
  /** `default`, `user`, `group`, or `domain`. */
  readonly type?: string
  readonly value?: string
}

export interface AclRule {
  readonly id?: string
  readonly kind?: string
  readonly etag?: string
  /** `none`, `freeBusyReader`, `reader`, `writer`, or `owner`. */
  readonly role?: string
  readonly scope?: AclScope
  readonly [key: string]: unknown
}

export interface AclList {
  readonly kind?: string
  readonly etag?: string
  readonly nextPageToken?: string
  readonly nextSyncToken?: string
  readonly items?: readonly AclRule[]
}

export type AclListOptions = QueryParams & {
  readonly maxResults?: number
  readonly pageToken?: string
  readonly showDeleted?: boolean
  readonly syncToken?: string
}

export type AclWriteOptions = QueryParams & {
  readonly sendNotifications?: boolean
}

export type AclWatchOptions = AclListOptions

// ---------------------------------------------------------------------------
// Settings (the authenticated user's calendar settings)
// ---------------------------------------------------------------------------

export interface Setting {
  readonly id?: string
  readonly kind?: string
  readonly etag?: string
  readonly value?: string
}

export interface SettingsList {
  readonly kind?: string
  readonly etag?: string
  readonly nextPageToken?: string
  readonly nextSyncToken?: string
  readonly items?: readonly Setting[]
}

export type SettingsListOptions = QueryParams & {
  readonly maxResults?: number
  readonly pageToken?: string
  readonly syncToken?: string
}

export type SettingsWatchOptions = SettingsListOptions

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface ColorDefinition {
  readonly background?: string
  readonly foreground?: string
}

export interface Colors {
  readonly kind?: string
  readonly updated?: string
  readonly calendar?: Readonly<Record<string, ColorDefinition>>
  readonly event?: Readonly<Record<string, ColorDefinition>>
}

// ---------------------------------------------------------------------------
// Free/busy
// ---------------------------------------------------------------------------

export interface FreeBusyRequestItem {
  readonly id: string
}

export interface FreeBusyRequest {
  readonly timeMin: string
  readonly timeMax: string
  readonly timeZone?: string
  readonly groupExpansionMax?: number
  readonly calendarExpansionMax?: number
  readonly items: readonly FreeBusyRequestItem[]
}

export interface FreeBusyError {
  readonly domain?: string
  /** `groupTooBig`, `tooManyCalendarsRequested`, `notFound`, `internalError`. */
  readonly reason?: string
}

export interface FreeBusyCalendar {
  readonly busy?: readonly TimePeriod[]
  readonly errors?: readonly FreeBusyError[]
}

export interface FreeBusyGroup {
  readonly calendars?: readonly string[]
  readonly errors?: readonly FreeBusyError[]
}

export interface FreeBusyResponse {
  readonly kind?: string
  readonly timeMin?: string
  readonly timeMax?: string
  readonly calendars?: Readonly<Record<string, FreeBusyCalendar>>
  readonly groups?: Readonly<Record<string, FreeBusyGroup>>
}
