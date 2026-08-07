import type { AceIotListAllOptions, AceIotPageOptions, AceIotTimestamp } from "./common"

/** A demand-response event scheduled against a client or gateway. */
export interface AceIotDerEvent {
  readonly id: string
  readonly timezone: string | null
  readonly event_start: AceIotTimestamp | null
  readonly event_end: AceIotTimestamp | null
  readonly event_type: string | null
  readonly group_name: string | null
  readonly client: string | null
  readonly created_by_user: string | null
  readonly cancelled: boolean | null
  readonly title: string | null
  readonly description: string | null
  readonly updated: AceIotTimestamp | null
  readonly created: AceIotTimestamp | null
}

/** A new event. ACE assigns the id. */
export interface AceIotCreateDerEventInput {
  readonly timezone?: string
  readonly event_start?: string
  readonly event_end?: string
  readonly event_type?: string
  readonly group_name?: string
  readonly cancelled?: boolean
  readonly title?: string
  readonly description?: string
}

/** An edit to an existing event, matched by `id`. */
export interface AceIotUpdateDerEventInput extends AceIotCreateDerEventInput {
  readonly id: string
}

export interface AceIotDerEventListOptions extends AceIotPageOptions {
  /** Also return events that ended up to 24 hours ago. Defaults to false. */
  readonly getPastEvents?: boolean
  readonly groupName?: string
}

export interface AceIotDerEventListAllOptions
  extends AceIotDerEventListOptions,
    AceIotListAllOptions {}
