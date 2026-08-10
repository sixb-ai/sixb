import type { UnipileHttp } from "../http"
import type {
  UnipileGetProfileOptions,
  UnipileInvitationSent,
  UnipileLinkedinProfile,
  UnipileRelationListOptions,
  UnipileRelationsResponse,
  UnipileSendInvitationInput,
} from "../types"
import { assertInvitationMessage, assertLimit, assertNonEmpty, pathId } from "../validation"

export interface UsersResource {
  /** `GET /users/{identifier}` */
  getProfile(identifier: string, options: UnipileGetProfileOptions): Promise<UnipileLinkedinProfile>
  /** `POST /users/invite` */
  sendInvitation(input: UnipileSendInvitationInput): Promise<UnipileInvitationSent>
  /** `GET /users/relations` — page-only because LinkedIn discourages aggressive polling. */
  listRelations(options: UnipileRelationListOptions): Promise<UnipileRelationsResponse>
}

export function createUsersResource(http: UnipileHttp): UsersResource {
  return {
    getProfile(identifier, options) {
      assertNonEmpty(options.account_id, "account_id")
      const sections = Array.isArray(options.linkedin_sections)
        ? options.linkedin_sections.join(",")
        : options.linkedin_sections
      return http.get(`users/${pathId(identifier, "user identifier")}`, {
        account_id: options.account_id,
        linkedin_api: options.linkedin_api === "classic" ? undefined : options.linkedin_api,
        linkedin_sections: sections,
        notify: options.notify,
      })
    },
    sendInvitation(input) {
      assertNonEmpty(input.account_id, "account_id")
      assertNonEmpty(input.provider_id, "provider_id")
      assertInvitationMessage(input.message)
      return http.post("users/invite", input)
    },
    listRelations(options) {
      assertNonEmpty(options.account_id, "account_id")
      assertLimit(options.limit, 1000)
      return http.get("users/relations", {
        account_id: options.account_id,
        limit: options.limit,
        cursor: options.cursor,
      })
    },
  }
}
