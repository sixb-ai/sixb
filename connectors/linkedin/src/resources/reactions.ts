import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertOffset, restliRecord, urnPath, withQuery } from "../restli"
import type {
  LinkedinOffsetPage,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
  LinkedinUrn,
} from "../types/common"
import type {
  LinkedinCreateReactionInput,
  LinkedinReaction,
  LinkedinReactionListOptions,
} from "../types/community"
import { type ElementsResponse, offsetPage } from "./community-utils"

export interface ReactionsResource {
  get(
    actor: LinkedinOrganizationUrn | LinkedinPersonUrn,
    entity: LinkedinUrn
  ): Promise<LinkedinReaction>
  listByEntity(
    entity: LinkedinUrn,
    options?: LinkedinReactionListOptions
  ): Promise<LinkedinOffsetPage<LinkedinReaction>>
  listAllByEntity(
    entity: LinkedinUrn,
    options?: LinkedinReactionListOptions
  ): AsyncIterable<LinkedinReaction>
  create(input: LinkedinCreateReactionInput): Promise<LinkedinReaction>
  delete(actor: LinkedinOrganizationUrn | LinkedinPersonUrn, entity: LinkedinUrn): Promise<void>
}

export function createReactionsResource(http: LinkedinHttp): ReactionsResource {
  const resource: ReactionsResource = {
    get(actor, entity) {
      return http.get(compoundPath(actor, entity))
    },
    async listByEntity(entity, options) {
      urnPath(entity, "reaction entity URN")
      assertOffset(options?.start, "start", 0)
      assertOffset(options?.count, "count", 1)
      const response = await http.get<ElementsResponse<LinkedinReaction>>(
        withQuery(`reactions/(entity:${encodeURIComponent(entity)})`, {
          q: "entity",
          sort: restliRecord({ value: options?.sort ?? "REVERSE_CHRONOLOGICAL" }),
          start: options?.start,
          count: options?.count,
        })
      )
      return offsetPage(response, options)
    },
    listAllByEntity(entity, options) {
      return listAllOffset((page) => resource.listByEntity(entity, page), options)
    },
    create(input) {
      urnPath(input.actor, "reaction actor URN")
      urnPath(input.entity, "reaction entity URN")
      if (input.reactionType === "MAYBE") {
        return Promise.reject(
          new Error("[SixbLinkedin] MAYBE is deprecated and cannot be used to create a reaction.")
        )
      }
      return http.post(withQuery("reactions", { actor: input.actor }), {
        root: input.entity,
        reactionType: input.reactionType,
      })
    },
    delete(actor, entity) {
      return http.delete(compoundPath(actor, entity))
    },
  }
  return resource
}

function compoundPath(
  actor: LinkedinOrganizationUrn | LinkedinPersonUrn,
  entity: LinkedinUrn
): string {
  urnPath(actor, "reaction actor URN")
  urnPath(entity, "reaction entity URN")
  return `reactions/(actor:${encodeURIComponent(actor)},entity:${encodeURIComponent(entity)})`
}
