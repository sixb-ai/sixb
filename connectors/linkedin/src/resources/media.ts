import type { LinkedinHttp } from "../http"
import { urnPath } from "../restli"
import type { LinkedinDocumentUrn, LinkedinImageUrn, LinkedinVideoUrn } from "../types/common"
import type { LinkedinDocument, LinkedinImage, LinkedinVideo } from "../types/media"

export interface ImagesResource {
  /** Resolve current image metadata and its signed download URL. */
  get(image: LinkedinImageUrn): Promise<LinkedinImage>
}

export interface VideosResource {
  /** Resolve current video metadata and its signed download URL. */
  get(video: LinkedinVideoUrn): Promise<LinkedinVideo>
}

export interface DocumentsResource {
  /** Resolve current document metadata and its signed download URL. */
  get(document: LinkedinDocumentUrn): Promise<LinkedinDocument>
}

export function createImagesResource(http: LinkedinHttp): ImagesResource {
  return {
    get(image) {
      return http.get(`images/${urnPath(image, "image URN")}`)
    },
  }
}

export function createVideosResource(http: LinkedinHttp): VideosResource {
  return {
    get(video) {
      return http.get(`videos/${urnPath(video, "video URN")}`)
    },
  }
}

export function createDocumentsResource(http: LinkedinHttp): DocumentsResource {
  return {
    get(document) {
      return http.get(`documents/${urnPath(document, "document URN")}`)
    },
  }
}
