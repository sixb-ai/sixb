import type { GraphPage, ListOptions, RequestOptions, SelectOptions } from "./common"
import type {
  MailAttachment,
  MailAttachmentSession,
  MailAttachmentUploadResult,
  MailBody,
  MailFileOptions,
} from "./mail"

export type CalendarBody = MailBody
export type CalendarAttachment = MailAttachment
export type CalendarAttachmentSession = MailAttachmentSession
export type CalendarAttachmentUploadResult = MailAttachmentUploadResult
export type CalendarFileOptions = MailFileOptions
export type CalendarColor =
  | "auto"
  | "lightBlue"
  | "lightGreen"
  | "lightOrange"
  | "lightGray"
  | "lightYellow"
  | "lightTeal"
  | "lightPink"
  | "lightBrown"
  | "lightRed"
  | "maxColor"
export type CalendarOnlineMeetingProvider =
  | "unknown"
  | "skypeForBusiness"
  | "skypeForConsumer"
  | "teamsForBusiness"
export interface CalendarEmailAddress {
  readonly address?: string | null
  readonly name?: string | null
}
export interface CalendarRecipient {
  readonly emailAddress: CalendarEmailAddress
}
export interface CalendarDateTime {
  readonly dateTime: string
  readonly timeZone: string
}
export type CalendarDay =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
export interface CalendarRecurrencePattern {
  readonly type:
    | "daily"
    | "weekly"
    | "absoluteMonthly"
    | "relativeMonthly"
    | "absoluteYearly"
    | "relativeYearly"
  readonly interval: number
  readonly month?: number
  readonly dayOfMonth?: number
  readonly daysOfWeek?: readonly CalendarDay[]
  readonly firstDayOfWeek?: CalendarDay
  readonly index?: "first" | "second" | "third" | "fourth" | "last"
}
export interface CalendarRecurrenceRange {
  readonly type: "endDate" | "noEnd" | "numbered"
  readonly startDate: string
  readonly endDate?: string
  readonly numberOfOccurrences?: number
  readonly recurrenceTimeZone?: string
}
export interface CalendarRecurrence {
  readonly pattern: CalendarRecurrencePattern
  readonly range: CalendarRecurrenceRange
}
export interface CalendarLocation {
  readonly displayName?: string | null
  readonly locationEmailAddress?: string | null
  readonly locationUri?: string | null
  readonly locationType?:
    | "default"
    | "conferenceRoom"
    | "homeAddress"
    | "businessAddress"
    | "geoCoordinates"
    | "streetAddress"
    | "hotel"
    | "restaurant"
    | "localBusiness"
    | "postalAddress"
  readonly uniqueId?: string | null
  readonly uniqueIdType?: "unknown" | "locationStore" | "directory" | "private" | "bing"
  readonly address?: {
    readonly street?: string | null
    readonly city?: string | null
    readonly state?: string | null
    readonly countryOrRegion?: string | null
    readonly postalCode?: string | null
  } | null
  readonly coordinates?: {
    readonly latitude?: number | null
    readonly longitude?: number | null
    readonly accuracy?: number | null
    readonly altitude?: number | null
    readonly altitudeAccuracy?: number | null
  } | null
}
export interface CalendarResponseStatus {
  readonly response?:
    | "none"
    | "organizer"
    | "tentativelyAccepted"
    | "accepted"
    | "declined"
    | "notResponded"
  readonly time?: string
}
export interface CalendarAttendee extends CalendarRecipient {
  readonly type: "required" | "optional" | "resource"
  readonly status?: CalendarResponseStatus | null
  readonly proposedNewTime?: CalendarTimeSlot | null
}
export interface CalendarTimeSlot {
  readonly start: CalendarDateTime
  readonly end: CalendarDateTime
}
export interface CalendarUpdate {
  readonly name?: string
  readonly color?: CalendarColor
  readonly isDefaultCalendar?: boolean
}
export interface Calendar {
  readonly id: string
  readonly name?: string | null
  readonly color?: CalendarColor | null
  readonly hexColor?: string | null
  readonly isDefaultCalendar?: boolean | null
  readonly isRemovable?: boolean | null
  readonly canEdit?: boolean | null
  readonly canShare?: boolean | null
  readonly canViewPrivateItems?: boolean | null
  readonly isTallyingResponses?: boolean | null
  readonly owner?: CalendarEmailAddress | null
  readonly changeKey?: string | null
  readonly allowedOnlineMeetingProviders?: readonly CalendarOnlineMeetingProvider[] | null
  readonly defaultOnlineMeetingProvider?: CalendarOnlineMeetingProvider | null
}
export type CalendarAvailability =
  | "free"
  | "tentative"
  | "busy"
  | "oof"
  | "workingElsewhere"
  | "unknown"
export interface CalendarEventUpdate {
  readonly subject?: string
  /** PATCH replaces the body. Preserve the existing Teams meeting HTML when editing it. */
  readonly body?: CalendarBody
  readonly start?: CalendarDateTime
  readonly end?: CalendarDateTime
  readonly isAllDay?: boolean
  readonly location?: CalendarLocation
  readonly locations?: readonly CalendarLocation[]
  readonly attendees?: readonly Omit<CalendarAttendee, "status" | "proposedNewTime">[]
  readonly recurrence?: CalendarRecurrence | null
  readonly categories?: readonly string[]
  readonly importance?: "low" | "normal" | "high"
  readonly sensitivity?: "normal" | "personal" | "private" | "confidential"
  readonly showAs?: CalendarAvailability
  readonly isReminderOn?: boolean
  readonly reminderMinutesBeforeStart?: number
  readonly responseRequested?: boolean
  readonly allowNewTimeProposals?: boolean
  readonly hideAttendees?: boolean
  readonly isOnlineMeeting?: boolean
  readonly onlineMeetingProvider?: CalendarOnlineMeetingProvider
}
export interface CalendarEventInput extends CalendarEventUpdate {
  readonly start: CalendarDateTime
  readonly end: CalendarDateTime
  /** Caller-owned stable identifier for a logical creation; reuse it after an uncertain result. */
  readonly transactionId?: string
}
/** Projections and delta records can omit properties. */
export interface CalendarEvent {
  readonly id: string
  readonly subject?: string | null
  readonly body?: CalendarBody | null
  readonly bodyPreview?: string | null
  readonly start?: CalendarDateTime | null
  readonly end?: CalendarDateTime | null
  readonly isAllDay?: boolean | null
  readonly type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster" | null
  readonly recurrence?: CalendarRecurrence | null
  readonly seriesMasterId?: string | null
  readonly originalStart?: string | null
  readonly originalStartTimeZone?: string | null
  readonly originalEndTimeZone?: string | null
  readonly cancelledOccurrences?: readonly string[] | null
  readonly exceptionOccurrences?: readonly CalendarEvent[] | null
  readonly attendees?: readonly CalendarAttendee[] | null
  readonly organizer?: CalendarRecipient | null
  readonly responseStatus?: CalendarResponseStatus | null
  readonly isOrganizer?: boolean | null
  readonly isCancelled?: boolean | null
  readonly isDraft?: boolean | null
  readonly location?: CalendarLocation | null
  readonly locations?: readonly CalendarLocation[] | null
  readonly categories?: readonly string[] | null
  readonly importance?: "low" | "normal" | "high" | null
  readonly sensitivity?: "normal" | "personal" | "private" | "confidential" | null
  readonly showAs?: CalendarAvailability | null
  readonly isReminderOn?: boolean | null
  readonly reminderMinutesBeforeStart?: number | null
  readonly responseRequested?: boolean | null
  readonly allowNewTimeProposals?: boolean | null
  readonly hideAttendees?: boolean | null
  readonly isOnlineMeeting?: boolean | null
  readonly onlineMeetingProvider?: CalendarOnlineMeetingProvider | null
  readonly onlineMeeting?: {
    readonly joinUrl?: string | null
    readonly conferenceId?: string | null
    readonly tollNumber?: string | null
    readonly tollFreeNumbers?: readonly string[] | null
    readonly quickDial?: string | null
    readonly phones?: readonly { readonly number?: string; readonly type?: string }[] | null
  } | null
  readonly hasAttachments?: boolean | null
  readonly attachments?: readonly CalendarAttachment[] | null
  readonly iCalUId?: string | null
  readonly transactionId?: string | null
  readonly changeKey?: string | null
  readonly createdDateTime?: string | null
  readonly lastModifiedDateTime?: string | null
  readonly webLink?: string | null
}
export interface CalendarRequestOptions extends RequestOptions {
  readonly timeZone?: string
}
export interface CalendarGetOptions extends SelectOptions, CalendarRequestOptions {}
export interface CalendarListOptions extends ListOptions, CalendarRequestOptions {
  readonly filter?: string
}
export interface CalendarViewOptions extends CalendarListOptions {
  /** Explicit ISO timestamp with UTC or an offset. */
  readonly startDateTime: string
  readonly endDateTime: string
  /** Omit to read the primary calendar. */
  readonly calendarId?: string
}
export type CalendarDeltaOptions = CalendarRequestOptions & { readonly pageSize?: number } & (
    | { readonly startDateTime: string; readonly endDateTime: string; readonly cursor?: never }
    | { readonly cursor: string; readonly startDateTime?: never; readonly endDateTime?: never }
  )
export interface CalendarDeltaPage
  extends GraphPage<
    CalendarEvent & {
      /** Removal from this view; not proof of deletion from the mailbox. */
      readonly "@removed"?: { readonly reason?: string }
    }
  > {
  readonly "@odata.deltaLink"?: string
}
export interface CalendarResponseInput {
  readonly comment?: string
  readonly sendResponse?: boolean
}
export interface CalendarProposalInput extends CalendarResponseInput {
  readonly proposedNewTime?: CalendarTimeSlot
}
export interface CalendarForwardInput {
  readonly comment?: string
  readonly toRecipients: readonly CalendarRecipient[]
}
export interface CalendarActionResult {
  readonly status: "accepted"
  readonly requestId?: string
}
export interface CalendarScheduleInput {
  readonly schedules: readonly string[]
  readonly startTime: CalendarDateTime
  readonly endTime: CalendarDateTime
  readonly availabilityViewInterval?: number
}
export interface CalendarSchedule {
  readonly scheduleId: string
  readonly availabilityView?: string | null
  readonly error?: {
    readonly message?: string | null
    readonly responseCode?: string | null
  } | null
  readonly scheduleItems?:
    | readonly {
        readonly status?: CalendarAvailability
        readonly start?: CalendarDateTime
        readonly end?: CalendarDateTime
        readonly subject?: string | null
        readonly location?: string | null
        readonly isPrivate?: boolean
      }[]
    | null
  readonly workingHours?: {
    readonly daysOfWeek?: readonly CalendarDay[]
    readonly startTime?: string
    readonly endTime?: string
    readonly timeZone?: CalendarScheduleTimeZone
  } | null
}

export interface CalendarScheduleTimeZone {
  readonly "@odata.type"?: string
  readonly name?: string
  readonly bias?: number
  readonly standardOffset?: CalendarTimeZoneOffset
  readonly daylightOffset?: CalendarTimeZoneOffset & { readonly daylightBias?: number }
}
export interface CalendarTimeZoneOffset {
  readonly time?: string
  readonly dayOccurrence?: number
  readonly dayOfWeek?: CalendarDay
  readonly month?: number
  readonly year?: number
}
