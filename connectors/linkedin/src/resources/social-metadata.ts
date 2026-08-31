import type { LinkedinHttp } from "../http"
import { urnPath, withQuery } from "../restli"
import type { LinkedinOrganizationUrn, LinkedinPersonUrn, LinkedinPostUrn } from "../types/common"
import type { LinkedinSocialEntityUrn, LinkedinSocialMetadata } from "../types/community"

export interface SocialMetadataResource {
  /** Aggregate comment and reaction counts for an organic or sponsored entity. */
  get(entity: LinkedinSocialEntityUrn): Promise<LinkedinSocialMetadata>
  /**
   * Enable or disable thread comments. Setting CLOSED permanently deletes existing comments.
   */
  setCommentsState(
    entity: LinkedinPostUrn,
    actor: LinkedinOrganizationUrn | LinkedinPersonUrn,
    state: "OPEN" | "CLOSED"
  ): Promise<void>
}

export function createSocialMetadataResource(http: LinkedinHttp): SocialMetadataResource {
  return {
    get(entity) {
      return http.get(`socialMetadata/${urnPath(entity, "social entity URN")}`)
    },
    setCommentsState(entity, actor, state) {
      urnPath(actor, "social metadata actor URN")
      return http.post(withQuery(`socialMetadata/${urnPath(entity, "post URN")}`, { actor }), {
        patch: { $set: { commentsState: state } },
      })
    },
  }
}
