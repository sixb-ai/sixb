import { type MetaHttpContext, nodePath, readJson, withQuery } from "../http"
import {
  allowedKeys,
  integer,
  mediaUrl,
  nonEmpty,
  scopeContext,
  textLimit,
  uploadVideo,
  write,
} from "../publishing"
import type {
  CreateInstagramContainerInput,
  InstagramContainerApi,
  MetaInstagramContainer,
  MetaInstagramContainerCreated,
  MetaResourceOptions,
} from "../types/publishing"

export function createInstagramContainer(
  context: MetaHttpContext,
  userPath: string,
  input: CreateInstagramContainerInput
): Promise<MetaInstagramContainerCreated> {
  validateContainer(input)
  return write(context, `${userPath}/media`, input)
}

export function createInstagramContainerApi(
  context: MetaHttpContext,
  id: string,
  options?: MetaResourceOptions
): InstagramContainerApi {
  const path = nodePath(id, "containerId")
  const scoped = scopeContext(context, options)
  return {
    get: (query) =>
      scoped.http
        .get(
          withQuery(path, {
            fields: (query?.fields ?? ["id", "status_code", "status"]).join(","),
          })
        )
        .then(readJson<MetaInstagramContainer>),
    upload: (uri, source) => uploadVideo(scoped, uri, id, "ig-api-upload", source),
  }
}

function validateContainer(input: CreateInstagramContainerInput): void {
  const child = "is_carousel_item" in input && input.is_carousel_item === true
  const common = child ? [] : ["caption", "location_id", "collaborators"]
  switch (input.media_type) {
    case undefined:
      allowedKeys(input, [...common, "image_url", "alt_text", "user_tags", "is_carousel_item"])
      mediaUrl(input.image_url, "image_url")
      textLimit(input.alt_text, "alt_text", 1000)
      if (input.is_carousel_item !== undefined && typeof input.is_carousel_item !== "boolean") {
        throw new Error("[SixbMeta] is_carousel_item must be a boolean.")
      }
      validateTags(input.user_tags, true)
      break
    case "REELS":
      allowedKeys(input, [
        ...common,
        "media_type",
        "video_url",
        "upload_type",
        "share_to_feed",
        "cover_url",
        "thumb_offset",
        "audio_name",
        "user_tags",
      ])
      videoSource(input)
      if (input.cover_url !== undefined) mediaUrl(input.cover_url, "cover_url")
      if (input.thumb_offset !== undefined) integer(input.thumb_offset, "thumb_offset", 0)
      if (input.audio_name !== undefined) nonEmpty(input.audio_name, "audio_name")
      if (input.share_to_feed !== undefined && typeof input.share_to_feed !== "boolean") {
        throw new Error("[SixbMeta] share_to_feed must be a boolean.")
      }
      validateTags(input.user_tags, false)
      break
    case "VIDEO":
      allowedKeys(input, [
        "media_type",
        "is_carousel_item",
        "video_url",
        "upload_type",
        "thumb_offset",
      ])
      if (!child)
        throw new Error(
          "[SixbMeta] VIDEO requires is_carousel_item=true; use REELS for standalone videos."
        )
      videoSource(input)
      if (input.thumb_offset !== undefined) integer(input.thumb_offset, "thumb_offset", 0)
      break
    case "CAROUSEL":
      allowedKeys(input, [...common, "media_type", "children"])
      if (
        !Array.isArray(input.children) ||
        input.children.length < 2 ||
        input.children.length > 10
      ) {
        throw new Error("[SixbMeta] A carousel requires 2 to 10 container IDs.")
      }
      for (const id of input.children) nonEmpty(id, "children")
      if (new Set(input.children).size !== input.children.length) {
        throw new Error("[SixbMeta] Carousel container IDs must be distinct.")
      }
      break
    default:
      throw new Error("[SixbMeta] Unsupported Instagram media_type.")
  }
  if ("caption" in input) textLimit(input.caption, "caption", 2200)
  if ("location_id" in input && input.location_id !== undefined)
    nonEmpty(input.location_id, "location_id")
  if ("collaborators" in input && input.collaborators !== undefined) {
    if (!Array.isArray(input.collaborators) || input.collaborators.length > 3) {
      throw new Error("[SixbMeta] collaborators must contain at most 3 usernames.")
    }
    for (const username of input.collaborators) nonEmpty(username, "collaborators")
  }
}

function videoSource(input: { readonly video_url?: string; readonly upload_type?: string }): void {
  if (input.upload_type === "resumable" && input.video_url === undefined) return
  if (input.upload_type === undefined && input.video_url !== undefined) {
    mediaUrl(input.video_url, "video_url")
    return
  }
  throw new Error("[SixbMeta] Specify video_url or upload_type=resumable, not both.")
}

function validateTags(
  tags:
    | readonly { readonly username: string; readonly x?: number; readonly y?: number }[]
    | undefined,
  image: boolean
): void {
  if (tags === undefined) return
  if (!Array.isArray(tags) || tags.length > 20) {
    throw new Error("[SixbMeta] user_tags must contain at most 20 tags.")
  }
  for (const tag of tags) {
    allowedKeys(tag, image ? ["username", "x", "y"] : ["username"])
    nonEmpty(tag.username, "user_tags.username")
    if (image) {
      for (const coordinate of [tag.x, tag.y]) {
        if (
          typeof coordinate !== "number" ||
          !Number.isFinite(coordinate) ||
          coordinate < 0 ||
          coordinate > 1
        ) {
          throw new Error("[SixbMeta] Image user tags require x and y between 0 and 1.")
        }
      }
    }
  }
}
