import { assertNonEmpty, assertPositiveIntegerInRange, type TiktokHttp } from "../http"
import { paginateCursor } from "../pagination"
import type { TiktokCursorPage } from "../types/common"
import type {
  TiktokOrganicComment,
  TiktokOrganicCommentsApi,
  TiktokOrganicCommentsListQuery,
  TiktokOrganicPost,
  TiktokOrganicPostsApi,
  TiktokOrganicPostsListQuery,
  TiktokOrganicProfile,
  TiktokOrganicProfileApi,
  TiktokOrganicProfileQuery,
  TiktokOrganicRepliesApi,
  TiktokOrganicRepliesListQuery,
} from "../types/organic"

interface VideoListData {
  readonly videos?: readonly TiktokOrganicPost[]
  readonly cursor?: number
  readonly has_more?: boolean
}

interface CommentListData {
  readonly comments?: readonly TiktokOrganicComment[]
  readonly cursor?: number
  readonly has_more?: boolean
}

export function createOrganicProfileApi(
  http: TiktokHttp,
  businessId: string
): TiktokOrganicProfileApi {
  return {
    async get(query) {
      validateProfileDates(query)
      const result = await http.get<TiktokOrganicProfile>("business/get/", {
        business_id: businessId,
        start_date: query?.startDate,
        end_date: query?.endDate,
        fields: query?.fields,
      })
      return result.data
    },
  }
}

export function createOrganicPostsApi(http: TiktokHttp, businessId: string): TiktokOrganicPostsApi {
  const list = (
    query: TiktokOrganicPostsListQuery | undefined,
    cursor = query?.cursor
  ): Promise<TiktokCursorPage<TiktokOrganicPost>> => listPosts(http, businessId, query, cursor)

  return {
    list,
    listAll(query) {
      return paginateCursor((cursor) => list(query, cursor), query?.cursor)
    },
  }
}

export function createOrganicCommentsApi(
  http: TiktokHttp,
  businessId: string
): TiktokOrganicCommentsApi {
  return {
    replies: createOrganicRepliesApi(http, businessId),
    list(query) {
      return listComments(http, businessId, query, query.cursor)
    },
    listAll(query) {
      return paginateCursor((cursor) => listComments(http, businessId, query, cursor), query.cursor)
    },
  }
}

function createOrganicRepliesApi(http: TiktokHttp, businessId: string): TiktokOrganicRepliesApi {
  return {
    list(query) {
      return listReplies(http, businessId, query, query.cursor)
    },
    listAll(query) {
      return paginateCursor((cursor) => listReplies(http, businessId, query, cursor), query.cursor)
    },
  }
}

async function listPosts(
  http: TiktokHttp,
  businessId: string,
  query: TiktokOrganicPostsListQuery | undefined,
  cursor: number | undefined
): Promise<TiktokCursorPage<TiktokOrganicPost>> {
  assertPositiveIntegerInRange(query?.maxCount, "maxCount", 20)
  const filters =
    query?.videoIds !== undefined || query?.adPostOnly !== undefined
      ? { video_ids: query.videoIds, ad_post_only: query.adPostOnly }
      : undefined
  const result = await http.get<VideoListData>("business/video/list/", {
    business_id: businessId,
    fields: query?.fields,
    filters,
    cursor,
    max_count: query?.maxCount,
  })
  return {
    items: result.data.videos ?? [],
    hasMore: result.data.has_more ?? false,
    nextCursor: result.data.cursor,
    requestId: result.requestId,
  }
}

async function listComments(
  http: TiktokHttp,
  businessId: string,
  query: TiktokOrganicCommentsListQuery,
  cursor: number | undefined
): Promise<TiktokCursorPage<TiktokOrganicComment>> {
  validateCommentQuery(query)
  if (query.commentIds && query.commentIds.length > 30) {
    throw new Error("[SixbTikTok] commentIds cannot contain more than 30 IDs.")
  }
  const result = await http.get<CommentListData>("business/comment/list/", {
    business_id: businessId,
    video_id: query.videoId,
    comment_ids: query.commentIds,
    include_replies: query.includeReplies,
    status: query.status,
    sort_field: query.sortField,
    sort_order: query.sortOrder,
    cursor,
    max_count: query.maxCount,
  })
  return commentPage(result)
}

async function listReplies(
  http: TiktokHttp,
  businessId: string,
  query: TiktokOrganicRepliesListQuery,
  cursor: number | undefined
): Promise<TiktokCursorPage<TiktokOrganicComment>> {
  validateCommentQuery(query)
  assertNonEmpty(query.commentId, "commentId")
  const result = await http.get<CommentListData>("business/comment/reply/list/", {
    business_id: businessId,
    video_id: query.videoId,
    comment_id: query.commentId,
    status: query.status,
    sort_field: query.sortField,
    sort_order: query.sortOrder,
    cursor,
    max_count: query.maxCount,
  })
  return commentPage(result)
}

function commentPage(result: {
  readonly data: CommentListData
  readonly requestId?: string
}): TiktokCursorPage<TiktokOrganicComment> {
  return {
    items: result.data.comments ?? [],
    hasMore: result.data.has_more ?? false,
    nextCursor: result.data.cursor,
    requestId: result.requestId,
  }
}

function validateCommentQuery(query: {
  readonly videoId: string
  readonly maxCount?: number
}): void {
  assertNonEmpty(query.videoId, "videoId")
  assertPositiveIntegerInRange(query.maxCount, "maxCount", 30)
}

function validateProfileDates(query: TiktokOrganicProfileQuery | undefined): void {
  if (query?.startDate) assertDate(query.startDate, "startDate")
  if (query?.endDate) assertDate(query.endDate, "endDate")
  if (!query?.startDate || !query.endDate) return

  const start = Date.parse(`${query.startDate}T00:00:00Z`)
  const end = Date.parse(`${query.endDate}T00:00:00Z`)
  if (start > end) {
    throw new Error("[SixbTikTok] startDate must not be after endDate.")
  }
  if ((end - start) / 86_400_000 > 59) {
    throw new Error("[SixbTikTok] profile insights cannot span more than 60 calendar days.")
  }
}

function assertDate(value: string, field: string): void {
  const parsed = new Date(`${value}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`[SixbTikTok] ${field} must use YYYY-MM-DD.`)
  }
}
