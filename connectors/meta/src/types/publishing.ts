/** Override the default token for every operation on this resource. */
export interface MetaResourceOptions {
  readonly accessToken?: string
}

export interface MetaCreatedObject {
  readonly id: string
}

export interface MetaUploadResult {
  readonly success: boolean
  readonly message?: string
}

/** Pass the complete file; offset selects the remaining bytes on resume. */
export type MetaVideoUploadSource =
  | { readonly file_url: string; readonly file?: never; readonly offset?: never }
  | { readonly file: Blob; readonly offset?: number; readonly file_url?: never }

export type InstagramVideoSource =
  | { readonly video_url: string; readonly upload_type?: never }
  | { readonly upload_type: "resumable"; readonly video_url?: never }

export interface InstagramImageTag {
  readonly username: string
  readonly x: number
  readonly y: number
}

export interface InstagramVideoTag {
  readonly username: string
}

export interface InstagramPostOptions {
  readonly caption?: string
  readonly location_id?: string
  readonly collaborators?: readonly string[]
}

export type CreateInstagramContainerInput =
  | (InstagramPostOptions & {
      readonly image_url: string
      readonly alt_text?: string
      readonly user_tags?: readonly InstagramImageTag[]
      readonly media_type?: never
      readonly is_carousel_item?: false
    })
  | {
      readonly image_url: string
      readonly alt_text?: string
      readonly user_tags?: readonly InstagramImageTag[]
      readonly is_carousel_item: true
      readonly media_type?: never
    }
  | (InstagramPostOptions &
      InstagramVideoSource & {
        readonly media_type: "REELS"
        readonly share_to_feed?: boolean
        readonly cover_url?: string
        /** Milliseconds from the start of the video; cover_url takes precedence. */
        readonly thumb_offset?: number
        readonly audio_name?: string
        readonly user_tags?: readonly InstagramVideoTag[]
      })
  | (InstagramVideoSource & {
      readonly media_type: "VIDEO"
      readonly is_carousel_item: true
      readonly thumb_offset?: number
    })
  | (InstagramPostOptions & {
      readonly media_type: "CAROUSEL"
      /** Ordered container IDs, not published media IDs. Between 2 and 10. */
      readonly children: readonly string[]
    })

export interface MetaInstagramContainerCreated extends MetaCreatedObject {
  /** Returned for upload_type=resumable. */
  readonly uri?: string
}

export interface MetaInstagramContainer extends MetaCreatedObject {
  readonly status_code?:
    | "IN_PROGRESS"
    | "FINISHED"
    | "ERROR"
    | "EXPIRED"
    | "PUBLISHED"
    | (string & {})
  readonly status?: string
  readonly copyright_check_status?: {
    readonly status?: string
    readonly matches_found?: boolean
  }
}

export interface MetaInstagramPublishingLimit {
  readonly data: readonly {
    readonly quota_usage?: number
    readonly config?: {
      readonly quota_total?: number
      readonly quota_duration?: number
    }
  }[]
}

export interface InstagramContainerApi {
  get(options?: { readonly fields?: readonly string[] }): Promise<MetaInstagramContainer>
  /** Transfer to the uri returned by media.create({ upload_type: "resumable", ... }). */
  upload(uri: string, source: MetaVideoUploadSource): Promise<MetaUploadResult>
}

export type FacebookPhotoSource =
  | { readonly url: string; readonly source?: never }
  | { readonly source: Blob; readonly url?: never }

export type CreateFacebookPhotoInput = FacebookPhotoSource & {
  readonly caption?: string
  readonly alt_text_custom?: string
  readonly published?: boolean
  /** Requires published=false; cannot be combined with scheduled_publish_time. */
  readonly temporary?: boolean
  readonly scheduled_publish_time?: number
}

export interface MetaFacebookPhotoCreated extends MetaCreatedObject {
  readonly post_id?: string
}

export interface CreateFacebookPostInput {
  readonly message?: string
  readonly link?: string
  readonly attached_media?: readonly { readonly media_fbid: string }[]
  readonly published?: boolean
  readonly scheduled_publish_time?: number
  readonly unpublished_content_type?: "SCHEDULED" | "DRAFT"
}

export type CreateFacebookVideoInput = (
  | { readonly file_url: string; readonly source?: never }
  | { readonly source: Blob; readonly file_url?: never }
) & {
  readonly title?: string
  readonly description?: string
  readonly published?: boolean
  readonly scheduled_publish_time?: number
}

export interface MetaFacebookReelSession {
  readonly video_id: string
  readonly upload_url: string
}

export type FinishFacebookReelInput = {
  readonly video_id: string
  readonly title?: string
  readonly description?: string
} & (
  | { readonly video_state: "PUBLISHED" | "DRAFT"; readonly scheduled_publish_time?: never }
  | { readonly video_state: "SCHEDULED"; readonly scheduled_publish_time: number }
)

export interface MetaFacebookReelResult extends MetaUploadResult {
  readonly video_id?: string
  readonly post_id?: string
}

export interface MetaFacebookVideoPhase {
  readonly status?: string
  readonly error?: unknown
  readonly errors?: unknown
}

export interface MetaFacebookVideo extends MetaCreatedObject {
  readonly permalink_url?: string
  readonly status?: {
    readonly video_status?: string
    readonly processing_progress?: number
    readonly uploading_phase?: MetaFacebookVideoPhase & {
      /** Meta's wire spelling. Also used as the resume offset. */
      readonly bytes_transfered?: number
      readonly source_file_size?: number
    }
    readonly processing_phase?: MetaFacebookVideoPhase
    readonly publishing_phase?: MetaFacebookVideoPhase & {
      readonly publish_status?: string
      readonly publish_time?: number
    }
  }
}

export interface FacebookVideoApi {
  get(options?: { readonly fields?: readonly string[] }): Promise<MetaFacebookVideo>
}

export interface FacebookPublishingApi {
  readonly photos: {
    create(input: CreateFacebookPhotoInput): Promise<MetaFacebookPhotoCreated>
  }
  readonly videos: {
    create(input: CreateFacebookVideoInput): Promise<MetaCreatedObject>
  }
  readonly reels: {
    start(): Promise<MetaFacebookReelSession>
    upload(
      session: MetaFacebookReelSession,
      source: MetaVideoUploadSource
    ): Promise<MetaUploadResult>
    finish(input: FinishFacebookReelInput): Promise<MetaFacebookReelResult>
  }
}
