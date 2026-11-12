import type { CtmHttp } from "../http"
import type {
  CtmAgentEvents,
  CtmAgentEventsOptions,
  CtmAgentUtilization,
  CtmId,
  CtmObject,
  CtmRecord,
  CtmTimeWindow,
  CtmUser,
  CtmUserGroup,
  CtmUserListOptions,
} from "../types"
import { assertNonEmpty, assertTimeWindow, pathId } from "../validation"
import {
  type CtmAccountPath,
  type CtmListMethods,
  type CtmReadMethods,
  listMethods,
  readMethods,
} from "./shared"

/** `GET /users` and `/users/{id}` — the account's users. A call's `agent_id` is a user's `id`. */
export type UsersResource = CtmReadMethods<CtmUser, CtmUserListOptions>

export function usersResource(http: CtmHttp, at: CtmAccountPath): UsersResource {
  return readMethods<CtmUser, CtmUserListOptions>(
    http,
    at,
    "users",
    "users",
    "userId",
    (options) => ({ email: options?.email, filter: options?.filter })
  )
}

/** `GET /user_groups` — teams of users. */
export type UserGroupsResource = CtmListMethods<CtmUserGroup>

export function userGroupsResource(http: CtmHttp, at: CtmAccountPath): UserGroupsResource {
  return listMethods(http, () => at("user_groups"), "user_groups")
}

/** Agents' phone presence now, and what they did over a window. */
export interface AgentsResource extends CtmListMethods<CtmRecord> {
  /** `GET /agents/{id}/phone_status` — one agent's current status and its history. */
  phoneStatus(agentId: CtmId): Promise<CtmObject>
  /** `GET /agents/by_status` — every agent's status, or only those in `statuses`. */
  byStatus(statuses?: readonly string[]): Promise<CtmObject>
  /** `GET /agents/events` — one agent's presence and activity changes over a window. */
  events(options: CtmAgentEventsOptions): Promise<CtmAgentEvents>
  /** `GET /agents/utilization` — every agent's time per state, and call counts, over a window. */
  utilization(options: CtmTimeWindow): Promise<CtmAgentUtilization>
}

export function agentsResource(http: CtmHttp, at: CtmAccountPath): AgentsResource {
  return {
    ...listMethods<CtmRecord>(http, () => at("agents"), "agents"),

    async phoneStatus(agentId) {
      return http.get<CtmObject>(at(`agents/${pathId(agentId, "agentId")}/phone_status`))
    },

    async byStatus(statuses) {
      return http.get<CtmObject>(at("agents/by_status"), {
        status: statuses?.length ? statuses.join(",") : undefined,
      })
    },

    async events(options) {
      assertNonEmpty(options.userId, "userId")
      assertTimeWindow(options.startTime, options.endTime)

      return http.get<CtmAgentEvents>(at("agents/events.json"), {
        user_id: options.userId,
        start_time: options.startTime,
        end_time: options.endTime,
      })
    },

    async utilization(options) {
      assertTimeWindow(options.startTime, options.endTime)

      return http.get<CtmAgentUtilization>(at("agents/utilization.json"), {
        start_time: options.startTime,
        end_time: options.endTime,
      })
    },
  }
}
