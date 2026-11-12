import type { CtmId } from "./common"

/**
 * The kinds of activity in the call log. Calls, text messages and form submissions share one
 * record shape and one list; `direction` tells them apart.
 */
export type CtmActivityDirection = "inbound" | "outbound" | "msg_inbound" | "msg_outbound" | "form"

/** How the call list is sorted: by time, by caller name, or by source name. */
export type CtmCallOrder = "metrics" | "caller" | "source"

export interface CtmCallListOptions {
  /** The cursor from a previous page's `after`. */
  readonly after?: string
  /** Records per page. CTM defaults to 10. */
  readonly pageSize?: number
  /** First day, inclusive, as `YYYY-MM-DD` in the account's time zone. */
  readonly startDate?: string
  /** Last day, inclusive, as `YYYY-MM-DD` in the account's time zone. */
  readonly endDate?: string
  /**
   * A relative window in place of `startDate` and `endDate`: `today`, `yesterday`, `last6hours`,
   * `last7days`, `thisweek`, `lastweek`, `thismonth`, `last3months`, … CTM caps it at about three
   * months.
   */
  readonly timeDuration?: string
  /** The first day of a week for `timeDuration`, such as `Sunday`. CTM defaults to Monday. */
  readonly startDay?: string
  /** Read `startDate` and `endDate` with their time of day. */
  readonly withTime?: boolean
  /** Only these kinds of activity. */
  readonly directions?: readonly CtmActivityDirection[]
  /**
   * Free text or field rules over caller ID, numbers and source, such as
   * `tracking_number:"14105555555"`, `source:"Google Ads"` or `status:"answered"`.
   */
  readonly filter?: string
  /** Prefix match on the contact's phone number. */
  readonly contactNumber?: string
  /** Return only these fields of each record, such as `["id", "audio"]`. */
  readonly fields?: readonly string[]
  readonly order?: CtmCallOrder
  /** Add duration statistics (count, total, mean, min, max, deviation) to `stats`. */
  readonly stats?: boolean
  /** Read every account of the agency instead of one. Needs an agency key. */
  readonly agencyWide?: boolean
}

export interface CtmCallSearchOptions extends CtmCallListOptions {
  /** The page to read, starting at 1. The search route pages by number as well as by `after`. */
  readonly page?: number
  /** CTM's query object: field-level conditions sent in the request body. */
  readonly query?: Readonly<Record<string, unknown>>
}

/** One page of the call log, read with the `after` cursor. */
export interface CtmCallPage {
  readonly records: readonly CtmCall[]
  /** The cursor for the next page, or `null` on the last page. */
  readonly after: string | null
  readonly perPage: number | null
  readonly totalEntries: number | null
  readonly totalPages: number | null
  /** Duration statistics when the list was read with `stats: true`, otherwise empty. */
  readonly stats: Readonly<Record<string, unknown>>
}

export interface CtmCallAgent {
  readonly id: string
  readonly name: string | null
  readonly email: string | null
  readonly pic_url?: string | null
}

/** One hop of the route a call took: a queue, a voice menu, a smart router, … */
export interface CtmCallPathStep {
  readonly route_name: string | null
  readonly route_id: string | null
  readonly route_type: string | null
  readonly started_at: string | null
}

/** One telephony leg of a call, as the carrier saw it. */
export interface CtmCallLeg {
  readonly sid: string
  readonly started_at: string | null
  readonly end_at: string | null
  readonly from: string | null
  readonly to: string | null
  readonly status: string | null
  readonly direction: string | null
  readonly duration: number | null
  readonly connect_duration: number | null
  /** Post-dial delay in milliseconds. */
  readonly pdd_ms: number | null
  readonly disconnected_by: string | null
  readonly from_carrier: string | null
  readonly from_connection: string | null
  readonly to_carrier: string | null
  readonly to_connection: string | null
  readonly tags: string | null
}

export interface CtmCallerAddress {
  readonly street: string | null
  readonly city: string | null
  readonly state: string | null
  readonly country: string | null
  readonly postal_code: string | null
}

/** The contact behind a call, in the call's detail only. */
export interface CtmCaller {
  /** Stable across the contact's activity: `<account>.<number>`. */
  readonly id: string
  readonly uid: number | null
  readonly account_id: number
  readonly agency_id: number | null
  readonly name: string | null
  readonly email: string | null
  readonly number: string | null
  readonly alternative_number: string | null
  readonly phone_type: string | null
  readonly caller_type: string | null
  readonly address: CtmCallerAddress | null
  readonly notes: readonly unknown[]
}

export interface CtmRateCenter {
  readonly country: string | null
  readonly prefix: string | null
  readonly tollfree: boolean | null
}

/**
 * One activity of the call log: a call, a text message or a form submission.
 *
 * CTM's records are dynamic. A call starts with few fields and gains more as it is answered,
 * routed, scored, transcribed or matched to an ad, sometimes hours after it ends; `fields` on a
 * list narrows them further. Only the IDs are always present.
 */
export interface CtmCall {
  readonly id: number
  readonly sid: string
  readonly account_id: number
  readonly direction?: CtmActivityDirection | (string & {})
  readonly status?: string | null
  readonly call_status?: string | null
  readonly dial_status?: string | null

  /** Local time with its offset, such as `2020-04-13 04:52 PM -04:00`. */
  readonly called_at?: string
  /** Seconds since the epoch. */
  readonly unix_time?: number
  readonly day?: string
  readonly month?: string
  readonly hour?: string
  /** Seconds. */
  readonly duration?: number | null
  /** Seconds. */
  readonly talk_time?: number | null
  /** Seconds. */
  readonly ring_time?: number | null
  /** Seconds. */
  readonly hold_time?: number | null
  /** Milliseconds. */
  readonly wait_time?: number | null
  readonly left_talk_time?: number | null
  readonly right_talk_time?: number | null

  readonly name?: string | null
  /** The caller ID name the carrier reported. */
  readonly cnam?: string | null
  readonly email?: string | null
  readonly caller_number?: string | null
  readonly caller_number_bare?: string | null
  readonly caller_number_complete?: string | null
  readonly caller_number_format?: string | null
  readonly caller_number_split?: readonly string[]
  readonly contact_number?: string | null
  readonly alternative_number?: string | null
  readonly is_new_caller?: boolean | null
  readonly street?: string | null
  readonly city?: string | null
  readonly state?: string | null
  readonly country?: string | null
  readonly postal_code?: string | null
  readonly latitude?: number | null
  readonly longitude?: number | null
  readonly caller?: CtmCaller

  readonly tracking_number_id?: CtmId | null
  readonly tracking_number_sid?: string | null
  readonly tracking_number?: string | null
  readonly tracking_number_bare?: string | null
  readonly tracking_number_format?: string | null
  readonly tracking_label?: string | null
  readonly inbound_rate_center?: CtmRateCenter | null

  readonly source?: string | null
  readonly source_id?: CtmId | null
  readonly source_sid?: string | null
  readonly referrer?: string | null
  readonly search?: string | null
  readonly location?: string | null
  readonly ga?: Readonly<Record<string, unknown>> | null
  readonly visitor?: boolean | Readonly<Record<string, unknown>> | null

  readonly agent_id?: string | null
  readonly agent?: CtmCallAgent | null
  readonly call_path?: readonly CtmCallPathStep[]
  readonly legs?: readonly CtmCallLeg[]
  readonly transfers?: readonly unknown[]
  /** The parent activity of a follow-up, such as the call a form triggered. */
  readonly parent_id?: number | null

  readonly tag_list?: readonly string[]
  readonly notes?: string | null
  readonly custom_fields?: Readonly<Record<string, unknown>>
  readonly spotted?: readonly unknown[]
  readonly likelihood?: number | null
  readonly excluded?: boolean
  readonly redacted?: boolean

  /** The recording's URL on CTM's API. Read it with `calls.recording(sid)`. */
  readonly audio?: string | null
  readonly billed_amount?: number | null
  readonly billed_at?: string | null
  readonly indexed_at?: number | null
}

/** One stretch of speech in a transcript. */
export interface CtmTranscriptSegment {
  readonly speaker: string | null
  readonly text: string
  /** Seconds from the start of the recording. */
  readonly s: number
  /** Seconds from the start of the recording. */
  readonly e: number
  readonly start_fmt: string
  readonly end_fmt: string
  readonly channel: number | null
  readonly confidence: number | null
  /** `[word, confidence, start, end]`, times in seconds. */
  readonly words: readonly (readonly [string, number, number, number])[]
  readonly offset?: number
  readonly gender?: string | null
  readonly vendor?: string | null
}

export interface CtmTranscript {
  readonly callid: number
  readonly text: string
  readonly sentiment: number | null
  readonly outline: readonly CtmTranscriptSegment[]
  readonly versions: readonly number[]
}

/** The caller fields CTM lets an API key change, and the call's custom fields by API name. */
export interface CtmCallUpdateInput {
  readonly name?: string
  readonly email?: string
  /** E.164, such as `+14105551212`. */
  readonly alternative_number?: string
  readonly street?: string
  readonly city?: string
  readonly state?: string
  readonly country?: string
  readonly postal_code?: string
  /** Comma-separated tags, from the account's predefined list. */
  readonly tag_list?: string
  readonly custom_fields?: Readonly<Record<string, string | number | boolean | null>>
  /** `0` skips the integrations and triggers CTM otherwise runs after the change. */
  readonly triggers?: 0 | 1
}

/** A call's conversion, as the agent or an integration recorded it. */
export interface CtmSaleInput {
  /** A reporting tag, typically a product or salesperson name. */
  readonly name?: string
  /** The call's quality, from 1 to 5. */
  readonly score?: number
  /** Whether the call resulted in a sale. */
  readonly conversion?: boolean
  /** What the call was worth, in dollars. */
  readonly value?: number
  /** `YYYY-MM-DD`. */
  readonly sale_date?: string
}

/**
 * A call's sale record. CTM publishes no response example, so the fields are those of the input
 * and whatever else CTM returns.
 */
export interface CtmSale {
  readonly name?: string | null
  readonly score?: number | null
  readonly conversion?: boolean | number | null
  readonly value?: number | null
  readonly sale_date?: string | null
  readonly [field: string]: unknown
}

export interface CtmCommentInput {
  readonly note: string
  /** The note's author, as an email or a `USR…` ID. Defaults to the call's agent. */
  readonly user?: string
}

export interface CtmComment {
  readonly id: number
  readonly call_id: number
  readonly note: string
  readonly owner: boolean
  readonly this_call: boolean
  readonly agent: {
    readonly id: string
    readonly name: string | null
    readonly email: string | null
    readonly pic: string | null
  } | null
}
