import type { LinkedinHttp } from "../http"
import {
  assertUploadUrl,
  type LinkedinMediaTransport,
  LinkedinMediaUploadError,
} from "../media-upload"
import { urnPath } from "../restli"
import type { LinkedinDocumentUrn, LinkedinImageUrn, LinkedinVideoUrn } from "../types/common"
import type {
  LinkedinDocument,
  LinkedinFinalizeVideoUploadInput,
  LinkedinImage,
  LinkedinImageUploadInput,
  LinkedinImageUploadSession,
  LinkedinInitializeImageUploadInput,
  LinkedinInitializeVideoUploadInput,
  LinkedinMediaRequestOptions,
  LinkedinMediaUploadOptions,
  LinkedinMediaWaitOptions,
  LinkedinVideo,
  LinkedinVideoUploadInput,
  LinkedinVideoUploadInstruction,
  LinkedinVideoUploadSession,
} from "../types/media"
import {
  assertFile,
  assertOwner,
  assertUnexpired,
  assertWaitOptions,
  waitForMedia,
} from "./media-utils"

export interface ImagesResource {
  /** Resolve current image metadata and its signed download URL. */
  get(image: LinkedinImageUrn, options?: LinkedinMediaRequestOptions): Promise<LinkedinImage>
  initializeUpload(
    input: LinkedinInitializeImageUploadInput,
    options?: LinkedinMediaRequestOptions
  ): Promise<LinkedinImageUploadSession>
  uploadContent(
    session: LinkedinImageUploadSession,
    file: Blob,
    options?: LinkedinMediaRequestOptions
  ): Promise<void>
  /** Initialize, transfer and (by default) wait until AVAILABLE. Does not publish a post. */
  upload(
    input: LinkedinImageUploadInput,
    options?: LinkedinMediaUploadOptions
  ): Promise<LinkedinImageUrn>
  waitUntilAvailable(
    image: LinkedinImageUrn,
    options?: LinkedinMediaWaitOptions
  ): Promise<LinkedinImage>
}

export interface VideosResource {
  /** Resolve current video metadata and its signed download URL. */
  get(video: LinkedinVideoUrn, options?: LinkedinMediaRequestOptions): Promise<LinkedinVideo>
  initializeUpload(
    input: LinkedinInitializeVideoUploadInput,
    options?: LinkedinMediaRequestOptions
  ): Promise<LinkedinVideoUploadSession>
  /** Pass the described bytes (ending at EOF for the final part). Returns the part's ETag. */
  uploadPart(
    instruction: LinkedinVideoUploadInstruction,
    part: Blob,
    options?: LinkedinMediaRequestOptions
  ): Promise<string>
  finalizeUpload(
    input: LinkedinFinalizeVideoUploadInput,
    options?: LinkedinMediaRequestOptions
  ): Promise<void>
  /** Upload the video itself in server-defined parts, finalize and wait until AVAILABLE by default. */
  upload(
    input: LinkedinVideoUploadInput,
    options?: LinkedinMediaUploadOptions
  ): Promise<LinkedinVideoUrn>
  waitUntilAvailable(
    video: LinkedinVideoUrn,
    options?: LinkedinMediaWaitOptions
  ): Promise<LinkedinVideo>
}

export interface DocumentsResource {
  /** Resolve current document metadata and its signed download URL. */
  get(document: LinkedinDocumentUrn): Promise<LinkedinDocument>
}

export function createImagesResource(
  http: LinkedinHttp,
  transport: LinkedinMediaTransport
): ImagesResource {
  const resource: ImagesResource = {
    get(image, options) {
      return http.get(`images/${urnPath(image, "image URN")}`, options)
    },
    async initializeUpload(input, options) {
      assertOwner(input.owner)
      const result = await http.post<{ value: LinkedinImageUploadSession }>(
        "images?action=initializeUpload",
        { initializeUploadRequest: input },
        options
      )
      assertMediaUrn(result?.value?.image, "image")
      assertUploadUrl(result.value.uploadUrl)
      assertUnexpired(result.value.uploadUrlExpiresAt)
      return result.value
    },
    async uploadContent(session, file, options) {
      assertFile(file)
      assertUnexpired(session.uploadUrlExpiresAt)
      await transport.put(session.uploadUrl, file, true, options?.signal)
    },
    async upload({ file, ...input }, options = {}) {
      assertFile(file)
      assertWaitOptions(options)
      const session = await resource.initializeUpload(input, options)
      await resource.uploadContent(session, file, options)
      if (options.waitUntilAvailable !== false)
        await resource.waitUntilAvailable(session.image, options)
      return session.image
    },
    waitUntilAvailable(image, options) {
      return waitForMedia(
        image,
        (signal) => resource.get(image, { signal }),
        transport.signal,
        options
      )
    },
  }
  return resource
}

export function createVideosResource(
  http: LinkedinHttp,
  transport: LinkedinMediaTransport
): VideosResource {
  const resource: VideosResource = {
    get(video, options) {
      return http.get(`videos/${urnPath(video, "video URN")}`, options)
    },
    async initializeUpload(input, options) {
      assertOwner(input.owner)
      if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes <= 0) {
        throw new Error("[SixbLinkedin] fileSizeBytes must be a positive safe integer.")
      }
      const result = await http.post<{ value: LinkedinVideoUploadSession }>(
        "videos?action=initializeUpload",
        { initializeUploadRequest: input },
        options
      )
      const session = result.value
      assertMediaUrn(session?.video, "video")
      assertUnexpired(session.uploadUrlsExpireAt)
      if (typeof session.uploadToken !== "string") {
        throw new LinkedinMediaUploadError("Missing video upload token.")
      }
      if (!Array.isArray(session.uploadInstructions) || !session.uploadInstructions.length) {
        throw new LinkedinMediaUploadError("Missing video upload ranges.")
      }
      // Validate the entire plan before transferring any bytes. Offsets are inclusive.
      let nextByte = 0
      for (const part of session.uploadInstructions) {
        assertInstruction(part)
        if (part.firstByte !== nextByte || part.firstByte >= input.fileSizeBytes) {
          throw new LinkedinMediaUploadError("Video upload ranges must be contiguous and ordered.")
        }
        nextByte = part.lastByte + 1
      }
      // LinkedIn's example reserves a full final range even when the file ends before lastByte.
      if (nextByte < input.fileSizeBytes) {
        throw new LinkedinMediaUploadError(
          "Video upload ranges do not cover the declared file size."
        )
      }
      return session
    },
    async uploadPart(instruction, part, options) {
      assertFile(part)
      assertInstruction(instruction)
      if (part.size > instruction.lastByte - instruction.firstByte + 1) {
        throw new Error("[SixbLinkedin] Video part exceeds its inclusive byte range.")
      }
      const headers = await transport.put(instruction.uploadUrl, part, false, options?.signal)
      const raw = headers.get("etag")
      // LinkedIn documents both quoted hashes and unquoted opaque signed IDs.
      const id = raw?.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
      if (!id?.trim()) {
        throw new LinkedinMediaUploadError(
          "Video upload response is missing its ETag; cannot finalize."
        )
      }
      return id
    },
    async finalizeUpload(input, options) {
      assertMediaUrn(input.video, "video")
      if (
        typeof input.uploadToken !== "string" ||
        !input.uploadedPartIds.length ||
        input.uploadedPartIds.some((id) => !id.trim())
      ) {
        throw new Error(
          "[SixbLinkedin] Video finalization requires an upload token and non-empty ordered part IDs."
        )
      }
      await http.post("videos?action=finalizeUpload", { finalizeUploadRequest: input }, options)
    },
    async upload({ file, ...input }, options = {}) {
      assertFile(file)
      assertWaitOptions(options)
      const session = await resource.initializeUpload(
        { ...input, fileSizeBytes: file.size, uploadCaptions: false, uploadThumbnail: false },
        options
      )
      const uploadedPartIds: string[] = []
      for (const instruction of session.uploadInstructions) {
        assertUnexpired(session.uploadUrlsExpireAt)
        uploadedPartIds.push(
          await resource.uploadPart(
            instruction,
            file.slice(instruction.firstByte, instruction.lastByte + 1),
            options
          )
        )
      }
      await resource.finalizeUpload(
        { video: session.video, uploadToken: session.uploadToken, uploadedPartIds },
        options
      )
      if (options.waitUntilAvailable !== false)
        await resource.waitUntilAvailable(session.video, options)
      return session.video
    },
    waitUntilAvailable(video, options) {
      return waitForMedia(
        video,
        (signal) => resource.get(video, { signal }),
        transport.signal,
        options
      )
    },
  }
  return resource
}

function assertMediaUrn(value: unknown, type: "image" | "video"): void {
  if (typeof value !== "string" || !new RegExp(`^urn:li:${type}:[^\\s:]+$`).test(value)) {
    throw new LinkedinMediaUploadError(`Expected a LinkedIn ${type} URN.`)
  }
}

function assertInstruction(part: LinkedinVideoUploadInstruction): void {
  assertUploadUrl(part?.uploadUrl)
  if (
    !Number.isSafeInteger(part.firstByte) ||
    !Number.isSafeInteger(part.lastByte) ||
    part.firstByte < 0 ||
    part.lastByte < part.firstByte ||
    part.lastByte >= Number.MAX_SAFE_INTEGER
  ) {
    throw new LinkedinMediaUploadError("Invalid inclusive video upload byte range.")
  }
}

export function createDocumentsResource(http: LinkedinHttp): DocumentsResource {
  return {
    get(document) {
      return http.get(`documents/${urnPath(document, "document URN")}`)
    },
  }
}
