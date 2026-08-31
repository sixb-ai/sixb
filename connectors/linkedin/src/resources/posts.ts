import type { LinkedinHttp } from "../http"
import { listAllOffset } from "../pagination"
import { assertOffset, urnPath, withQuery } from "../restli"
import type {
  LinkedinCreatedEntity,
  LinkedinOffsetPage,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
  LinkedinPostUrn,
} from "../types/common"
import type {
  LinkedinCreatePostInput,
  LinkedinPost,
  LinkedinPostListOptions,
  LinkedinPostViewContext,
  LinkedinUpdatePostInput,
} from "../types/community"
import { type ElementsResponse, offsetPage } from "./community-utils"

export interface PostsResource {
  get(post: LinkedinPostUrn, viewContext?: LinkedinPostViewContext): Promise<LinkedinPost>
  listByAuthor(
    author: LinkedinOrganizationUrn | LinkedinPersonUrn,
    options?: LinkedinPostListOptions
  ): Promise<LinkedinOffsetPage<LinkedinPost>>
  listAllByAuthor(
    author: LinkedinOrganizationUrn | LinkedinPersonUrn,
    options?: LinkedinPostListOptions
  ): AsyncIterable<LinkedinPost>
  create(input: LinkedinCreatePostInput): Promise<LinkedinCreatedEntity>
  update(post: LinkedinPostUrn, input: LinkedinUpdatePostInput): Promise<void>
  delete(post: LinkedinPostUrn): Promise<void>
}

export function createPostsResource(http: LinkedinHttp): PostsResource {
  const resource: PostsResource = {
    get(post, viewContext) {
      return http.get(withQuery(`posts/${urnPath(post, "post URN")}`, { viewContext }))
    },
    async listByAuthor(author, options) {
      urnPath(author, "post author URN")
      assertOffset(options?.start, "start", 0)
      assertOffset(options?.count, "count", 1)
      if (options?.count !== undefined && options.count > 100) {
        throw new Error("[SixbLinkedin] post count must be between 1 and 100.")
      }
      const response = await http.get<ElementsResponse<LinkedinPost>>(
        withQuery("posts", {
          q: "author",
          author,
          sortBy: options?.sortBy,
          start: options?.start,
          count: options?.count,
        }),
        { headers: { "X-RestLi-Method": "FINDER" } }
      )
      return offsetPage(response, options)
    },
    listAllByAuthor(author, options) {
      return listAllOffset(
        (page) => resource.listByAuthor(author, page),
        options?.count === undefined ? { ...options, count: 100 } : options
      )
    },
    async create(input) {
      assertCreatePostInput(input)
      urnPath(input.author, "post author URN")
      return http.create("posts", input)
    },
    update(post, input) {
      if (Object.keys(input).length === 0) {
        return Promise.reject(new Error("[SixbLinkedin] post update must set at least one field."))
      }
      return http.post(
        `posts/${urnPath(post, "post URN")}`,
        { patch: { $set: input } },
        { headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } }
      )
    },
    delete(post) {
      return http.delete(`posts/${urnPath(post, "post URN")}`)
    },
  }
  return resource
}

function assertCreatePostInput(input: LinkedinCreatePostInput): void {
  if (typeof input.commentary !== "string") {
    throw new Error("[SixbLinkedin] post commentary is required.")
  }
  if (input.lifecycleState !== "PUBLISHED") {
    throw new Error("[SixbLinkedin] post lifecycleState must be PUBLISHED during creation.")
  }

  const poll = input.content?.poll
  if (!poll) return

  if (characterCount(poll.question) < 1 || characterCount(poll.question) > 140) {
    throw new Error("[SixbLinkedin] poll question must contain between 1 and 140 characters.")
  }
  if (poll.options.length < 2 || poll.options.length > 4) {
    throw new Error("[SixbLinkedin] poll must contain between 2 and 4 options.")
  }
  for (const option of poll.options) {
    if (characterCount(option.text) < 1 || characterCount(option.text) > 30) {
      throw new Error("[SixbLinkedin] poll option text must contain between 1 and 30 characters.")
    }
  }
  if (poll.settings.voteSelectionType === "MULTIPLE_VOTE") {
    throw new Error("[SixbLinkedin] LinkedIn does not currently support multiple-vote polls.")
  }
  if (poll.settings.isVoterVisibleToAuthor === false) {
    throw new Error(
      "[SixbLinkedin] LinkedIn requires isVoterVisibleToAuthor to be true when it is provided."
    )
  }
}

function characterCount(value: string): number {
  return [...value].length
}
