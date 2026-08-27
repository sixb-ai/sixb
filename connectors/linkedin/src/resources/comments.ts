import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertOffset, pathId, urnPath, withQuery } from "../restli"
import type {
  LinkedinCreatedResource,
  LinkedinOffsetOptions,
  LinkedinOffsetPage,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
} from "../types/common"
import type {
  LinkedinComment,
  LinkedinCreateCommentInput,
  LinkedinSocialEntityUrn,
  LinkedinUpdateCommentInput,
} from "../types/community"
import { type ElementsResponse, offsetPage } from "./community-utils"

export interface CommentsResource {
  list(
    entity: LinkedinSocialEntityUrn,
    options?: LinkedinOffsetOptions
  ): Promise<LinkedinOffsetPage<LinkedinComment>>
  listAll(
    entity: LinkedinSocialEntityUrn,
    options?: LinkedinOffsetOptions
  ): AsyncIterable<LinkedinComment>
  get(entity: LinkedinSocialEntityUrn, commentId: string | number): Promise<LinkedinComment>
  create(
    entity: LinkedinSocialEntityUrn,
    input: LinkedinCreateCommentInput
  ): Promise<LinkedinCreatedResource<LinkedinComment>>
  update(
    entity: LinkedinSocialEntityUrn,
    commentId: string | number,
    input: LinkedinUpdateCommentInput
  ): Promise<LinkedinComment>
  delete(
    entity: LinkedinSocialEntityUrn,
    commentId: string | number,
    actor?: LinkedinOrganizationUrn | LinkedinPersonUrn
  ): Promise<void>
}

export function createCommentsResource(http: LinkedinHttp): CommentsResource {
  const resource: CommentsResource = {
    async list(entity, options) {
      assertOffset(options?.start, "start", 0)
      assertOffset(options?.count, "count", 1)
      const response = await http.get<ElementsResponse<LinkedinComment>>(
        withQuery(collectionPath(entity), {
          start: options?.start,
          count: options?.count,
        })
      )
      return offsetPage(response, options)
    },
    listAll(entity, options) {
      return listAllOffset((page) => resource.list(entity, page), options)
    },
    get(entity, commentId) {
      return http.get(`${collectionPath(entity)}/${pathId(commentId, "comment id")}`)
    },
    create(entity, input) {
      urnPath(input.actor, "comment actor URN")
      if (entity.startsWith("urn:li:comment:") && (!input.object || !input.parentComment)) {
        return Promise.reject(
          new Error(
            "[SixbLinkedin] nested comments require both object and parentComment in the input."
          )
        )
      }
      if (input.object) urnPath(input.object, "comment object URN")
      if (input.parentComment) urnPath(input.parentComment, "parent comment URN")
      if (!input.message.text.trim()) {
        return Promise.reject(new Error("[SixbLinkedin] comment text must not be empty."))
      }
      return http.createWithResponse<LinkedinComment>(collectionPath(entity), {
        ...input,
        object: input.object ?? entity,
      })
    },
    update(entity, commentId, input) {
      if (!input.message.text.trim()) {
        return Promise.reject(new Error("[SixbLinkedin] comment text must not be empty."))
      }
      if (input.actor) urnPath(input.actor, "comment actor URN")
      return http.post(
        withQuery(`${collectionPath(entity)}/${pathId(commentId, "comment id")}`, {
          actor: input.actor,
        }),
        { patch: { message: { $set: input.message } } },
        { headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } }
      )
    },
    delete(entity, commentId, actor) {
      if (actor) urnPath(actor, "comment actor URN")
      return http.delete(
        withQuery(`${collectionPath(entity)}/${pathId(commentId, "comment id")}`, { actor })
      )
    },
  }
  return resource
}

function collectionPath(entity: LinkedinSocialEntityUrn): string {
  return `socialActions/${urnPath(entity, "social entity URN")}/comments`
}
