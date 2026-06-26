import { DEFAULT_FACEBOOK_PAGE_FIELDS, DEFAULT_FACEBOOK_POST_FIELDS } from "../fields"
import {
  authInit,
  insightsPath,
  type MetaHttpContext,
  nodePath,
  paginate,
  readInsights,
  readObject,
  readPage,
  toUnixSeconds,
  withQuery,
} from "../http"
import type { InsightsQuery, MetaInsight, MetaPage } from "../types/common"
import type {
  FacebookPageApi,
  MetaFacebookAttachment,
  MetaFacebookPageProfile,
  MetaFacebookPost,
  PostsListOptions,
} from "../types/facebook"

export function createFacebookPageApi(
  context: MetaHttpContext,
  pageId: string,
  options?: { readonly accessToken?: string }
): FacebookPageApi {
  const page = nodePath(pageId, "pageId")
  const init = authInit(options?.accessToken)

  return {
    get: (getOptions) => {
      const requested = withQuery(page, {
        fields: (getOptions?.fields ?? DEFAULT_FACEBOOK_PAGE_FIELDS).join(","),
      })
      return context.http
        .get(requested, init)
        .then((response) => readObject(response, toPageProfile))
    },
    posts: {
      list: (listOptions) =>
        listPosts(context, `${page}/published_posts`, listOptions, listOptions?.after, init),
      listAll: (listOptions) =>
        paginate((after) =>
          listPosts(context, `${page}/published_posts`, listOptions, after, init)
        ),
    },
    insights: {
      get: (query) => getInsights(context, `${page}/insights`, query, init),
    },
  }
}

function listPosts(
  context: MetaHttpContext,
  path: string,
  options: PostsListOptions | undefined,
  after: string | undefined,
  init: RequestInit | undefined
): Promise<MetaPage<MetaFacebookPost>> {
  const baseFields = options?.fields ?? DEFAULT_FACEBOOK_POST_FIELDS
  const fields = options?.metrics?.length
    ? [...baseFields, `insights.metric(${options.metrics.join(",")}).period(lifetime)`]
    : baseFields
  const requested = withQuery(path, {
    fields: fields.join(","),
    limit: options?.limit ?? 100,
    since: options?.since ? toUnixSeconds(options.since) : undefined,
    until: options?.until ? toUnixSeconds(options.until) : undefined,
    after,
  })
  return context.http.get(requested, init).then((response) => readPage(response, toPost))
}

function getInsights(
  context: MetaHttpContext,
  path: string,
  query: InsightsQuery,
  init: RequestInit | undefined
): Promise<readonly MetaInsight[]> {
  if (query.metrics.length === 0) {
    return Promise.resolve([])
  }
  return context.http.get(insightsPath(path, query), init).then(readInsights)
}

interface RawPageProfile {
  readonly id: string
  readonly name?: string
  readonly fan_count?: number
  readonly followers_count?: number
}

function toPageProfile(raw: RawPageProfile): MetaFacebookPageProfile {
  return {
    id: raw.id,
    name: raw.name,
    fan_count: raw.fan_count,
    followers_count: raw.followers_count,
  }
}

interface RawPost {
  readonly id: string
  readonly message?: string
  readonly story?: string
  readonly created_time?: string
  readonly permalink_url?: string
  readonly status_type?: string
  readonly comments?: { readonly summary?: { readonly total_count?: number } }
  readonly reactions?: { readonly summary?: { readonly total_count?: number } }
  readonly shares?: { readonly count?: number }
  readonly attachments?: { readonly data?: readonly MetaFacebookAttachment[] }
  readonly insights?: { readonly data?: readonly MetaInsight[] }
}

function toPost(raw: RawPost): MetaFacebookPost {
  return {
    id: raw.id,
    message: raw.message,
    story: raw.story,
    created_time: raw.created_time,
    permalink_url: raw.permalink_url,
    status_type: raw.status_type,
    attachments: raw.attachments?.data,
    reactions_count: raw.reactions?.summary?.total_count,
    comments_count: raw.comments?.summary?.total_count,
    shares_count: raw.shares?.count,
    insights: raw.insights?.data,
  }
}
