import { type MetaHttpContext, nodePath, readJson, withQuery } from "../http"
import {
  allowedKeys,
  integer,
  mediaBody,
  mediaUrl,
  nonEmpty,
  optionalText,
  scopeContext,
  uploadVideo,
  write,
} from "../publishing"
import type {
  CreateFacebookPostInput,
  FacebookPublishingApi,
  FacebookVideoApi,
  MetaCreatedObject,
  MetaFacebookVideo,
  MetaResourceOptions,
} from "../types/publishing"

export function createFacebookPublishingApi(
  context: MetaHttpContext,
  page: string
): FacebookPublishingApi {
  return {
    photos: {
      create(input) {
        allowedKeys(input, [
          "url",
          "source",
          "caption",
          "alt_text_custom",
          "published",
          "temporary",
          "scheduled_publish_time",
        ])
        validateSource(input, "url")
        optionalText(input.caption, "caption")
        optionalText(input.alt_text_custom, "alt_text_custom")
        validatePublication(input)
        if (input.temporary !== undefined && typeof input.temporary !== "boolean") {
          throw new Error("[SixbMeta] temporary must be a boolean.")
        }
        if (
          input.temporary &&
          (input.published !== false || input.scheduled_publish_time !== undefined)
        ) {
          throw new Error(
            "[SixbMeta] temporary photos require published=false and no scheduled_publish_time."
          )
        }
        return write(context, `${page}/photos`, mediaBody(input))
      },
    },
    videos: {
      create(input) {
        allowedKeys(input, [
          "file_url",
          "source",
          "title",
          "description",
          "published",
          "scheduled_publish_time",
        ])
        validateSource(input, "file_url")
        optionalText(input.title, "title")
        optionalText(input.description, "description")
        validatePublication(input)
        return write(context, `${page}/videos`, mediaBody(input))
      },
    },
    reels: {
      start: () => write(context, `${page}/video_reels`, { upload_phase: "start" }, "session"),
      upload: (session, source) => {
        nonEmpty(session.video_id, "video_id")
        return uploadVideo(context, session.upload_url, session.video_id, "video-upload", source)
      },
      finish(input) {
        allowedKeys(input, [
          "video_id",
          "video_state",
          "title",
          "description",
          "scheduled_publish_time",
        ])
        nonEmpty(input.video_id, "video_id")
        optionalText(input.title, "title")
        optionalText(input.description, "description")
        if (!["PUBLISHED", "DRAFT", "SCHEDULED"].includes(input.video_state)) {
          throw new Error("[SixbMeta] Invalid video_state.")
        }
        if (input.video_state === "SCHEDULED") {
          integer(input.scheduled_publish_time, "scheduled_publish_time", 1)
        } else if (input.scheduled_publish_time !== undefined) {
          throw new Error("[SixbMeta] scheduled_publish_time requires video_state=SCHEDULED.")
        }
        return write(
          context,
          `${page}/video_reels`,
          { ...input, upload_phase: "finish" },
          "success"
        )
      },
    },
  }
}

export function createFacebookPost(
  context: MetaHttpContext,
  page: string,
  input: CreateFacebookPostInput
): Promise<MetaCreatedObject> {
  allowedKeys(input, [
    "message",
    "link",
    "attached_media",
    "published",
    "scheduled_publish_time",
    "unpublished_content_type",
  ])
  validatePublication(input)
  if (input.message !== undefined) nonEmpty(input.message, "message")
  if (input.link !== undefined) mediaUrl(input.link, "link")
  if (input.attached_media !== undefined) {
    if (
      input.scheduled_publish_time !== undefined &&
      input.unpublished_content_type !== "SCHEDULED"
    ) {
      throw new Error(
        "[SixbMeta] Scheduled multi-photo posts require unpublished_content_type=SCHEDULED."
      )
    }
    if (!Array.isArray(input.attached_media) || input.attached_media.length === 0) {
      throw new Error("[SixbMeta] attached_media must be a non-empty array.")
    }
    if (input.link !== undefined)
      throw new Error("[SixbMeta] link cannot be combined with attached_media.")
    for (const item of input.attached_media) {
      allowedKeys(item, ["media_fbid"])
      nonEmpty(item.media_fbid, "media_fbid")
    }
  }
  if (
    input.message === undefined &&
    input.link === undefined &&
    input.attached_media === undefined
  ) {
    throw new Error("[SixbMeta] A post requires message, link or attached_media.")
  }
  if (input.unpublished_content_type !== undefined) {
    if (
      !["SCHEDULED", "DRAFT"].includes(input.unpublished_content_type) ||
      input.published !== false
    ) {
      throw new Error(
        "[SixbMeta] unpublished_content_type requires published=false and SCHEDULED or DRAFT."
      )
    }
    if (
      input.unpublished_content_type === "SCHEDULED" &&
      input.scheduled_publish_time === undefined
    ) {
      throw new Error("[SixbMeta] SCHEDULED requires scheduled_publish_time.")
    }
    if (input.unpublished_content_type === "DRAFT" && input.scheduled_publish_time !== undefined) {
      throw new Error("[SixbMeta] DRAFT cannot have scheduled_publish_time.")
    }
  }
  return write(context, `${page}/feed`, input)
}

export function createFacebookVideoApi(
  context: MetaHttpContext,
  id: string,
  options?: MetaResourceOptions
): FacebookVideoApi {
  const scoped = scopeContext(context, options)
  const path = nodePath(id, "videoId")
  return {
    get: (query) =>
      scoped.http
        .get(
          withQuery(path, {
            fields: (query?.fields ?? ["id", "status", "permalink_url"]).join(","),
          })
        )
        .then(readJson<MetaFacebookVideo>),
  }
}

function validateSource(
  input: { readonly source?: Blob; readonly url?: string; readonly file_url?: string },
  key: "url" | "file_url"
): void {
  if (input[key] !== undefined && input.source === undefined) {
    mediaUrl(input[key], key)
    return
  }
  if (input[key] === undefined && input.source instanceof Blob && input.source.size > 0) return
  throw new Error(`[SixbMeta] Specify ${key} or a non-empty source Blob, not both.`)
}

function validatePublication(input: {
  readonly published?: boolean
  readonly scheduled_publish_time?: number
}): void {
  if (input.published !== undefined && typeof input.published !== "boolean") {
    throw new Error("[SixbMeta] published must be a boolean.")
  }
  if (input.scheduled_publish_time !== undefined) {
    integer(input.scheduled_publish_time, "scheduled_publish_time", 1)
    if (input.published !== false) {
      throw new Error("[SixbMeta] scheduled_publish_time requires published=false.")
    }
  }
}
