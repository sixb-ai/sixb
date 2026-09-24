import type { TiktokExtensible } from "./common"

export type TiktokPostPrivacy =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY"

export interface TiktokPublishingSettings {
  readonly privacy_level_options: readonly TiktokPostPrivacy[]
  readonly comment_disabled: boolean
  readonly duet_disabled: boolean
  readonly stitch_disabled: boolean
  readonly max_video_post_duration_sec: number
}

export interface TiktokCommercialDisclosure {
  /** Promotes the creator's own business. Required; never inferred by Sixb. */
  readonly is_brand_organic: boolean
  /** Paid partnership with a third party. Takes precedence when both flags are true. */
  readonly is_branded_content: boolean
}

export interface TiktokVideoPostInfo extends TiktokCommercialDisclosure {
  readonly upload_to_draft?: false
  /** At most 2,200 UTF-16 code units and 30 mentions. */
  readonly caption?: string
  readonly disable_comment?: boolean
  readonly disable_duet?: boolean
  readonly disable_stitch?: boolean
  /** Cover timestamp in milliseconds; ignored when custom_thumbnail_url is provided. */
  readonly thumbnail_offset?: number
  readonly is_ai_generated?: boolean
}

export interface TiktokVideoDraftInfo {
  /** Requires video.upload. TikTok ignores all other post_info fields for video drafts. */
  readonly upload_to_draft: true
}

export interface TiktokPublishVideoInput {
  /** Public HTTP(S) URL on a verified domain. Keep accessible for at least 30 minutes. */
  readonly video_url: string
  readonly custom_thumbnail_url?: string
  /** Business video publishing is public; it has no privacy_level parameter. */
  readonly post_info: TiktokVideoPostInfo | TiktokVideoDraftInfo
}

export interface TiktokPhotoPostInfo extends TiktokCommercialDisclosure {
  readonly is_draft?: false
  readonly privacy_level: TiktokPostPrivacy
  /** At most 90 UTF-16 code units. */
  readonly title?: string
  /** At most 4,000 UTF-16 code units and 30 mentions. */
  readonly caption?: string
  readonly disable_comment?: boolean
  readonly auto_add_music?: boolean
}

export interface TiktokPhotoDraftInfo {
  /** Requires video.upload. Only title and caption are retained for photo drafts. */
  readonly is_draft: true
  readonly title?: string
  readonly caption?: string
}

export interface TiktokPublishPhotosInput {
  /** 1–35 public HTTP(S) URLs on a verified domain; JPEG/WebP, at most 20 MB each. */
  readonly photo_images: readonly string[]
  /** Zero-based index; TikTok defaults to the first photo. */
  readonly photo_cover_index?: number
  readonly post_info: TiktokPhotoPostInfo | TiktokPhotoDraftInfo
}

export interface TiktokPublishTask {
  /** Publishing task ID, not a post ID. Pass to getStatus and persist before polling. */
  readonly share_id: string
}

export interface TiktokPublishStatus {
  readonly status: TiktokExtensible<
    "PROCESSING_DOWNLOAD" | "PUBLISH_COMPLETE" | "FAILED" | "SEND_TO_USER_INBOX"
  >
  /** Only for publicly viewable completed posts; may arrive up to three minutes later. */
  readonly post_ids?: readonly string[]
  /** Provider failure reason, present when status is FAILED. */
  readonly reason?: string
}

export interface TiktokPublishingApi {
  /** Fetch current account constraints before rendering the publishing UI. */
  getSettings(): Promise<TiktokPublishingSettings>
  /** Starts an asynchronous task. Never automatically retried. */
  publishVideo(input: TiktokPublishVideoInput): Promise<TiktokPublishTask>
  /** Starts an asynchronous task. Never automatically retried. */
  publishPhotos(input: TiktokPublishPhotosInput): Promise<TiktokPublishTask>
  getStatus(publishId: string): Promise<TiktokPublishStatus>
}
