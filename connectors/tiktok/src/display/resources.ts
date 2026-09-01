import { assertNonEmpty, assertPositiveIntegerInRange } from "../http"
import { paginateCursor } from "../pagination"
import type { TiktokCursorPage } from "../types/common"
import type {
  TiktokDisplayProfileApi,
  TiktokDisplayUser,
  TiktokDisplayUserField,
  TiktokDisplayVideo,
  TiktokDisplayVideoField,
  TiktokDisplayVideosApi,
  TiktokDisplayVideosListQuery,
  TiktokDisplayVideosQuery,
} from "../types/display"
import type { TiktokDisplayHttp } from "./http"

const DEFAULT_USER_FIELDS = ["open_id", "display_name", "avatar_url"] as const
const DEFAULT_VIDEO_FIELDS = [
  "id",
  "create_time",
  "cover_image_url",
  "share_url",
  "video_description",
  "duration",
  "height",
  "width",
  "title",
  "embed_html",
  "embed_link",
  "like_count",
  "comment_count",
  "share_count",
  "view_count",
] as const satisfies readonly TiktokDisplayVideoField[]

interface UserInfoData {
  readonly user: TiktokDisplayUser
}

interface VideoListData {
  readonly videos?: readonly TiktokDisplayVideo[]
  readonly cursor?: number
  readonly has_more?: boolean
}

interface VideoQueryData {
  readonly videos?: readonly TiktokDisplayVideo[]
}

export function createDisplayProfileApi(http: TiktokDisplayHttp): TiktokDisplayProfileApi {
  return {
    async get(query) {
      return getDisplayProfile(http, query?.fields)
    },
  }
}

export async function getDisplayProfile(
  http: TiktokDisplayHttp,
  fields: readonly TiktokDisplayUserField[] = DEFAULT_USER_FIELDS
): Promise<TiktokDisplayUser> {
  const result = await http.get<UserInfoData>("user/info/", fields)
  return result.data.user
}

export function createDisplayVideosApi(http: TiktokDisplayHttp): TiktokDisplayVideosApi {
  const list = (
    query: TiktokDisplayVideosListQuery | undefined,
    cursor = query?.cursor
  ): Promise<TiktokCursorPage<TiktokDisplayVideo>> => listVideos(http, query, cursor)

  return {
    list,
    listAll(query) {
      return paginateCursor((cursor) => list(query, cursor), query?.cursor)
    },
    async query(query) {
      validateVideoQuery(query)
      const result = await http.post<VideoQueryData>(
        "video/query/",
        query.fields ?? DEFAULT_VIDEO_FIELDS,
        { filters: { video_ids: query.videoIds } }
      )
      return result.data.videos ?? []
    },
  }
}

async function listVideos(
  http: TiktokDisplayHttp,
  query: TiktokDisplayVideosListQuery | undefined,
  cursor: number | undefined
): Promise<TiktokCursorPage<TiktokDisplayVideo>> {
  assertPositiveIntegerInRange(query?.maxCount, "maxCount", 20)
  const result = await http.post<VideoListData>(
    "video/list/",
    query?.fields ?? DEFAULT_VIDEO_FIELDS,
    compactBody({ cursor, max_count: query?.maxCount })
  )
  return {
    items: result.data.videos ?? [],
    hasMore: result.data.has_more ?? false,
    nextCursor: result.data.cursor,
    requestId: result.logId,
  }
}

function validateVideoQuery(query: TiktokDisplayVideosQuery): void {
  if (query.videoIds.length === 0 || query.videoIds.length > 20) {
    throw new Error("[SixbTikTok] videoIds must contain between one and 20 IDs.")
  }
  for (const videoId of query.videoIds) assertNonEmpty(videoId, "videoIds")
}

function compactBody(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}
