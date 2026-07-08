import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  AclList,
  AclListOptions,
  AclRule,
  AclWatchOptions,
  AclWriteOptions,
  Channel,
} from "../../types/calendar"

function aclPath(calendarId: string, suffix = ""): string {
  return `calendars/${pathSegment(calendarId, "calendarId")}/acl${suffix}`
}

function rulePath(calendarId: string, ruleId: string): string {
  return aclPath(calendarId, `/${pathSegment(ruleId, "ruleId")}`)
}

export interface AclResource {
  /** `GET /calendars/{calendarId}/acl` — one page of access rules. */
  list(calendarId: string, options?: AclListOptions): Promise<AclList>
  /** Iterate every ACL rule across all pages. */
  listAll(calendarId: string, options?: AclListOptions): AsyncIterable<AclRule>
  /** `GET /calendars/{calendarId}/acl/{ruleId}`. */
  get(calendarId: string, ruleId: string): Promise<AclRule>
  /** `POST /calendars/{calendarId}/acl` — grant access. */
  insert(calendarId: string, rule: AclRule, options?: AclWriteOptions): Promise<AclRule>
  /** `PUT /calendars/{calendarId}/acl/{ruleId}` — full replacement. */
  update(
    calendarId: string,
    ruleId: string,
    rule: AclRule,
    options?: AclWriteOptions
  ): Promise<AclRule>
  /** `PATCH /calendars/{calendarId}/acl/{ruleId}` — partial update. */
  patch(
    calendarId: string,
    ruleId: string,
    rule: Partial<AclRule>,
    options?: AclWriteOptions
  ): Promise<AclRule>
  /** `DELETE /calendars/{calendarId}/acl/{ruleId}`. */
  delete(calendarId: string, ruleId: string): Promise<void>
  /** `POST /calendars/{calendarId}/acl/watch` — open a push-notification channel. */
  watch(calendarId: string, channel: Channel, options?: AclWatchOptions): Promise<Channel>
}

export function aclResource(http: GoogleHttp): AclResource {
  const resource: AclResource = {
    list(calendarId, options) {
      return http.json<AclList>("calendar", "GET", aclPath(calendarId), { query: options })
    },
    listAll(calendarId, options) {
      return listAllPages<AclList, AclRule>(
        (pageToken) => resource.list(calendarId, { ...options, pageToken }),
        (page) => page.items,
        options?.pageToken
      )
    },
    get(calendarId, ruleId) {
      return http.json<AclRule>("calendar", "GET", rulePath(calendarId, ruleId))
    },
    insert(calendarId, rule, options) {
      return http.json<AclRule>("calendar", "POST", aclPath(calendarId), {
        query: options,
        body: rule,
      })
    },
    update(calendarId, ruleId, rule, options) {
      return http.json<AclRule>("calendar", "PUT", rulePath(calendarId, ruleId), {
        query: options,
        body: rule,
      })
    },
    patch(calendarId, ruleId, rule, options) {
      return http.json<AclRule>("calendar", "PATCH", rulePath(calendarId, ruleId), {
        query: options,
        body: rule,
      })
    },
    delete(calendarId, ruleId) {
      return http.json<void>("calendar", "DELETE", rulePath(calendarId, ruleId))
    },
    watch(calendarId, channel, options) {
      return http.json<Channel>("calendar", "POST", aclPath(calendarId, "/watch"), {
        query: options,
        body: channel,
      })
    },
  }

  return resource
}
