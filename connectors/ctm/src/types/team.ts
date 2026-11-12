import type { CtmPageOptions } from "./common"

export interface CtmUserListOptions extends CtmPageOptions {
  readonly email?: string
  /** Matches users by name. */
  readonly filter?: string
}

/**
 * A user of the account. Agents are users: a call's `agent_id` is a user's `id`, while the agent
 * analytics key their numbers by `uid`.
 */
export interface CtmUser {
  /** `USR…`. */
  readonly id: string
  readonly uid: number
  readonly account_id: number
  readonly first_name: string | null
  readonly last_name: string | null
  readonly email: string | null
  readonly role: string | null
  /** Phone presence, such as `online` or `offline`. */
  readonly status: string | null
  readonly language: string | null
  readonly pic_url: string | null
  readonly inbound_number: string | null
  readonly outbound_number?: {
    readonly id: string
    readonly country_code: string
    readonly base_number: string
  } | null
  readonly sip_phone?: { readonly uri: string | null } | null
  readonly live_calls: readonly unknown[]
  readonly desk_mode_default?: boolean
  readonly url?: string
}

export interface CtmUserGroup {
  readonly id: number
  readonly account_id: number
  readonly name: string
  /** The members' `uid`s. */
  readonly user_ids: readonly number[]
  readonly created_at: string
  readonly updated_at: string
}

export interface CtmQueueListOptions extends CtmPageOptions {
  readonly name?: string
}

/** A call queue: the agents it rings, in order, and what happens when none answers. */
export interface CtmQueue {
  /** `CQ…`, the `route_id` of a call path step through this queue. */
  readonly id: string
  readonly name: string
  readonly url?: string
  readonly wait_music?: string | null
  readonly default_action_type?: string | null
  readonly default_action_id?: number | string | null
  readonly default_action_label?: string | null
  readonly after_hours_action_type?: string | null
  readonly after_hours_action_id?: number | string | null
  readonly after_hours_action_label?: string | null
  readonly post_call_action_type?: string | null
  readonly post_call_action_id?: number | string | null
  readonly post_call_action_label?: string | null
  readonly prompt_agent_to_accept?: boolean
  readonly fast_kill_agent_call?: boolean
  readonly callerid_number_id?: string | null
  readonly total_agents?: number
  readonly total_numbers?: number
  readonly schedule?: unknown
  readonly agents?: string
  readonly numbers?: string
  readonly [field: string]: unknown
}

/** A time window, in seconds since the epoch. */
export interface CtmTimeWindow {
  readonly startTime: number
  readonly endTime: number
}

export interface CtmAgentEventsOptions extends CtmTimeWindow {
  /** The agent's `USR…` ID. */
  readonly userId: string
}

/** A presence or activity change: online, wrap-up, accepting calls, a call ending, … */
export interface CtmAgentEvent {
  readonly event: string
  /** Seconds since the epoch. */
  readonly time: number
  readonly user_id: string
  /** The record the event concerns, such as a call. */
  readonly what_id: number | string | null
  readonly what_type: string | null
  readonly data: Readonly<Record<string, unknown>> | null
  readonly class?: string
  readonly icon?: string
}

export interface CtmAgentEvents {
  readonly start_time: number
  readonly end_time: number
  /** Where the events stop, which can be before `end_time`. */
  readonly result_end_time: number
  readonly events: readonly CtmAgentEvent[]
}

/** One agent's time in one state over the window. Times are in seconds. */
export interface CtmAgentUtilizationEvent {
  readonly event: string
  readonly user_id: number
  readonly count?: number
  readonly total: number | null
  readonly average?: number | null
  readonly active_total?: number | null
  readonly last_time?: number
}

export interface CtmAgentUtilizationMetric {
  readonly user_id: number
  readonly total: number
  readonly time?: number
}

/** Each agent's time per state, and call and chat counts, over a window. Keyed by user `uid`. */
export interface CtmAgentUtilization {
  readonly start_time: number
  readonly end_time: number
  readonly included_users: readonly number[]
  readonly excluded_users: readonly number[]
  readonly events: readonly CtmAgentUtilizationEvent[]
  readonly users: Readonly<
    Record<
      string,
      {
        readonly name: string
        readonly email: string | null
        readonly pic_url: string | null
        readonly initials?: string
      }
    >
  >
  /** `inbound_calls`, `outbound_calls`, `chats`, `talk_time`, `handle_time`, … */
  readonly metrics: Readonly<Record<string, readonly CtmAgentUtilizationMetric[]>>
}
