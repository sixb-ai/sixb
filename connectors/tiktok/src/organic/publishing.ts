import { assertNonEmpty, assertNonNegativeInteger, type TiktokHttp } from "../http"
import type {
  TiktokCommercialDisclosure,
  TiktokPublishingApi,
  TiktokPublishingSettings,
  TiktokPublishPhotosInput,
  TiktokPublishStatus,
  TiktokPublishTask,
  TiktokPublishVideoInput,
} from "../types/publishing"

export function createPublishingApi(http: TiktokHttp, businessId: string): TiktokPublishingApi {
  return {
    async getSettings() {
      return (
        await http.get<TiktokPublishingSettings>("business/video/settings/", {
          business_id: businessId,
        })
      ).data
    },
    async publishVideo(input) {
      validateVideo(input)
      const result = await http.post<TiktokPublishTask>("business/video/publish/", {
        video_url: input.video_url,
        custom_thumbnail_url: input.custom_thumbnail_url,
        post_info: input.post_info,
        business_id: businessId,
      })
      assertNonEmpty(result.data.share_id, "response share_id")
      return result.data
    },
    async publishPhotos(input) {
      validatePhotos(input)
      const result = await http.post<TiktokPublishTask>("business/photo/publish/", {
        photo_images: input.photo_images,
        photo_cover_index: input.photo_cover_index,
        post_info: input.post_info,
        business_id: businessId,
      })
      assertNonEmpty(result.data.share_id, "response share_id")
      return result.data
    },
    async getStatus(publishId) {
      assertNonEmpty(publishId, "publishId")
      return (
        await http.get<TiktokPublishStatus>("business/publish/status/", {
          business_id: businessId,
          publish_id: publishId,
        })
      ).data
    },
  }
}

function validateVideo(input: TiktokPublishVideoInput): void {
  assertMediaUrl(input.video_url, "video_url")
  if (input.custom_thumbnail_url !== undefined) {
    assertMediaUrl(input.custom_thumbnail_url, "custom_thumbnail_url")
  }
  const info = input.post_info
  assertPostInfo(info)
  if (info.upload_to_draft === true) {
    assertFields(info, ["upload_to_draft"])
    return
  }
  // Reject unsupported metadata rather than letting TikTok ignore a privacy/draft choice.
  assertFields(info, [
    "upload_to_draft",
    "caption",
    "is_brand_organic",
    "is_branded_content",
    "disable_comment",
    "disable_duet",
    "disable_stitch",
    "thumbnail_offset",
    "is_ai_generated",
  ])
  assertDisclosure(info)
  assertText(info.caption, "caption", 2200)
  assertOptionalBoolean(info.upload_to_draft, "upload_to_draft")
  assertOptionalBoolean(info.disable_comment, "disable_comment")
  assertOptionalBoolean(info.disable_duet, "disable_duet")
  assertOptionalBoolean(info.disable_stitch, "disable_stitch")
  assertOptionalBoolean(info.is_ai_generated, "is_ai_generated")
  if (info.thumbnail_offset !== undefined) {
    assertNonNegativeInteger(info.thumbnail_offset, "thumbnail_offset")
  }
}

function validatePhotos(input: TiktokPublishPhotosInput): void {
  if (
    !Array.isArray(input.photo_images) ||
    input.photo_images.length < 1 ||
    input.photo_images.length > 35
  ) {
    throw new Error("[SixbTikTok] photo_images must contain between 1 and 35 URLs.")
  }
  for (const url of input.photo_images) assertMediaUrl(url, "photo_images")
  if (input.photo_cover_index !== undefined) {
    assertNonNegativeInteger(input.photo_cover_index, "photo_cover_index")
    if (input.photo_cover_index >= input.photo_images.length) {
      throw new Error("[SixbTikTok] photo_cover_index must reference a supplied photo.")
    }
  }
  const info = input.post_info
  assertPostInfo(info)
  assertText(info.title, "title", 90)
  assertText(info.caption, "caption", 4000)
  if (info.is_draft === true) {
    assertFields(info, ["is_draft", "title", "caption"])
    return
  }
  assertFields(info, [
    "is_draft",
    "title",
    "caption",
    "privacy_level",
    "is_brand_organic",
    "is_branded_content",
    "disable_comment",
    "auto_add_music",
  ])
  assertDisclosure(info)
  if (
    !["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"].includes(
      info.privacy_level
    )
  ) {
    throw new Error("[SixbTikTok] privacy_level must be an explicit TikTok privacy option.")
  }
  assertOptionalBoolean(info.is_draft, "is_draft")
  assertOptionalBoolean(info.disable_comment, "disable_comment")
  assertOptionalBoolean(info.auto_add_music, "auto_add_music")
}

function assertPostInfo(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("[SixbTikTok] post_info is required.")
  }
}

function assertDisclosure(info: TiktokCommercialDisclosure): void {
  if (typeof info.is_brand_organic !== "boolean" || typeof info.is_branded_content !== "boolean") {
    throw new Error(
      "[SixbTikTok] is_brand_organic and is_branded_content must be explicit booleans."
    )
  }
}

function assertFields(info: object, allowed: readonly string[]): void {
  for (const [key, value] of Object.entries(info)) {
    if (value !== undefined && !allowed.includes(key)) {
      throw new Error(`[SixbTikTok] ${key} is not supported for this publication mode; omit it.`)
    }
  }
}

function assertOptionalBoolean(value: boolean | undefined, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`[SixbTikTok] ${field} must be a boolean.`)
  }
}

function assertText(value: string | undefined, field: string, maximum: number): void {
  // String.length matches TikTok's UTF-16 limits, including surrogate pairs.
  if (value !== undefined && (typeof value !== "string" || value.length > maximum)) {
    throw new Error(`[SixbTikTok] ${field} must contain at most ${maximum} UTF-16 code units.`)
  }
}

function assertMediaUrl(value: string, field: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbTikTok] ${field} must be an absolute HTTP(S) URL.`)
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(
      `[SixbTikTok] ${field} must be an HTTP(S) URL without credentials or a fragment.`
    )
  }
}
