import {
  DEFAULT_INSTAGRAM_MEDIA_FIELDS,
  DEFAULT_INSTAGRAM_STORY_FIELDS,
  DEFAULT_INSTAGRAM_USER_FIELDS,
} from "../fields"
import {
  insightsPath,
  type MetaHttpContext,
  nodePath,
  paginate,
  readInsights,
  readObject,
  readPage,
  withQuery,
} from "../http"
import type { InsightsQuery, MetaInsight, MetaPage } from "../types/common"
import type {
  InstagramMediaApi,
  InstagramUserApi,
  MediaListOptions,
  MetaInstagramMedia,
  MetaInstagramMediaChild,
  MetaInstagramUser,
  StoriesListOptions,
} from "../types/instagram"

export function createInstagramUserApi(
  context: MetaHttpContext,
  igUserId: string
): InstagramUserApi {
  const userPath = nodePath(igUserId, "igUserId")

  return {
    get: (options) => {
      const requested = withQuery(userPath, {
        fields: (options?.fields ?? DEFAULT_INSTAGRAM_USER_FIELDS).join(","),
      })
      return context.http.get(requested).then((response) => readObject(response, toInstagramUser))
    },
    media: {
      list: (options) => listMedia(context, `${userPath}/media`, options, options?.after),
      listAll: (options) =>
        paginate((after) => listMedia(context, `${userPath}/media`, options, after)),
    },
    stories: {
      list: (options) => listStories(context, `${userPath}/stories`, options, options?.after),
      listAll: (options) =>
        paginate((after) => listStories(context, `${userPath}/stories`, options, after)),
    },
    insights: {
      get: (options) => getInsights(context, `${userPath}/insights`, options),
    },
  }
}

export function createInstagramMediaApi(
  context: MetaHttpContext,
  mediaId: string
): InstagramMediaApi {
  const path = `${nodePath(mediaId, "mediaId")}/insights`
  return {
    insights: {
      get: ({ metrics }) => getInsights(context, path, { metrics }),
    },
  }
}

function listMedia(
  context: MetaHttpContext,
  path: string,
  options: MediaListOptions | undefined,
  after: string | undefined
): Promise<MetaPage<MetaInstagramMedia>> {
  const baseFields = options?.fields ?? DEFAULT_INSTAGRAM_MEDIA_FIELDS
  const fields = options?.metrics?.length
    ? [...baseFields, `insights.metric(${options.metrics.join(",")})`]
    : baseFields
  const requested = withQuery(path, {
    fields: fields.join(","),
    limit: options?.limit ?? 100,
    after,
  })
  return context.http.get(requested).then((response) => readPage(response, toMedia))
}

function listStories(
  context: MetaHttpContext,
  path: string,
  options: StoriesListOptions | undefined,
  after: string | undefined
): Promise<MetaPage<MetaInstagramMedia>> {
  const baseFields = options?.fields ?? DEFAULT_INSTAGRAM_STORY_FIELDS
  const fields = options?.metrics?.length
    ? [...baseFields, `insights.metric(${options.metrics.join(",")})`]
    : baseFields
  const requested = withQuery(path, {
    fields: fields.join(","),
    limit: options?.limit ?? 100,
    after,
  })
  return context.http.get(requested).then((response) => readPage(response, toMedia))
}

function getInsights(
  context: MetaHttpContext,
  path: string,
  query: InsightsQuery
): Promise<readonly MetaInsight[]> {
  if (query.metrics.length === 0) {
    return Promise.resolve([])
  }
  return context.http.get(insightsPath(path, query)).then(readInsights)
}

interface RawInstagramUser {
  readonly id: string
  readonly username?: string
  readonly name?: string
  readonly biography?: string
  readonly website?: string
  readonly profile_picture_url?: string
  readonly followers_count?: number
  readonly follows_count?: number
  readonly media_count?: number
}

function toInstagramUser(raw: RawInstagramUser): MetaInstagramUser {
  return {
    id: raw.id,
    username: raw.username,
    name: raw.name,
    biography: raw.biography,
    website: raw.website,
    profile_picture_url: raw.profile_picture_url,
    followers_count: raw.followers_count,
    follows_count: raw.follows_count,
    media_count: raw.media_count,
  }
}

interface RawMedia {
  readonly id: string
  readonly caption?: string
  readonly media_type?: string
  readonly media_product_type?: string
  readonly media_url?: string
  readonly thumbnail_url?: string
  readonly permalink?: string
  readonly timestamp?: string
  readonly username?: string
  readonly like_count?: number
  readonly comments_count?: number
  readonly children?: { readonly data?: readonly MetaInstagramMediaChild[] }
  readonly insights?: { readonly data?: readonly MetaInsight[] }
}

function toMedia(raw: RawMedia): MetaInstagramMedia {
  return {
    id: raw.id,
    caption: raw.caption,
    media_type: raw.media_type,
    media_product_type: raw.media_product_type,
    media_url: raw.media_url,
    thumbnail_url: raw.thumbnail_url,
    permalink: raw.permalink,
    timestamp: raw.timestamp,
    username: raw.username,
    like_count: raw.like_count,
    comments_count: raw.comments_count,
    children: raw.children?.data,
    insights: raw.insights?.data,
  }
}
