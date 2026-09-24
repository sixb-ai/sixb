import type {
  LinkedinDocumentUrn,
  LinkedinImageUrn,
  LinkedinOrganizationUrn,
  LinkedinPersonUrn,
  LinkedinSponsoredAccountUrn,
  LinkedinVideoUrn,
} from "./common"

export type LinkedinMediaStatus =
  | "WAITING_UPLOAD"
  | "PROCESSING"
  | "PROCESSING_FAILED"
  | "AVAILABLE"

export interface LinkedinMediaLibraryMetadata {
  readonly associatedAccount: LinkedinSponsoredAccountUrn
  readonly assetName: string
  readonly mediaLibraryStatus?: "ACTIVE" | "ARCHIVED"
  [field: string]: unknown
}

interface LinkedinMediaAsset {
  readonly owner: LinkedinOrganizationUrn | LinkedinPersonUrn | LinkedinSponsoredAccountUrn
  readonly status?: LinkedinMediaStatus
  readonly downloadUrl?: string
  readonly downloadUrlExpiresAt?: number
  readonly mediaLibraryMetadata?: LinkedinMediaLibraryMetadata
  [field: string]: unknown
}

export interface LinkedinImage extends LinkedinMediaAsset {
  readonly id: LinkedinImageUrn
  readonly aspectRatioHeight?: number
  readonly aspectRatioWidth?: number
  readonly altText?: string
}

export interface LinkedinVideo extends LinkedinMediaAsset {
  readonly id: LinkedinVideoUrn
  readonly processingFailureReason?: string
  /** Duration in milliseconds. */
  readonly duration?: number
  readonly aspectRatioHeight?: number
  readonly aspectRatioWidth?: number
  readonly thumbnail?: string
  readonly captions?: string
  readonly transcript?: string
}

export interface LinkedinDocument extends LinkedinMediaAsset {
  readonly id: LinkedinDocumentUrn
  readonly thumbnail?: string
  readonly pageCount?: number
}

export interface LinkedinMediaRequestOptions {
  readonly signal?: AbortSignal
}

export interface LinkedinMediaWaitOptions extends LinkedinMediaRequestOptions {
  /** Total processing wait, including requests. Defaults to five minutes. */
  readonly timeoutMs?: number
  /** Defaults to one second. */
  readonly pollIntervalMs?: number
}

export interface LinkedinMediaUploadOptions extends LinkedinMediaWaitOptions {
  /** Defaults to true. Disable when the grant cannot read media status. */
  readonly waitUntilAvailable?: boolean
}

export interface LinkedinInitializeImageUploadInput {
  readonly owner: LinkedinOrganizationUrn | LinkedinPersonUrn
  readonly mediaLibraryMetadata?: LinkedinMediaLibraryMetadata
}

export interface LinkedinImageUploadSession {
  readonly image: LinkedinImageUrn
  readonly uploadUrl: string
  readonly uploadUrlExpiresAt: number
}

export interface LinkedinImageUploadInput extends LinkedinInitializeImageUploadInput {
  readonly file: Blob
}

export interface LinkedinInitializeVideoUploadInput extends LinkedinInitializeImageUploadInput {
  readonly fileSizeBytes: number
  readonly uploadCaptions?: boolean
  readonly uploadThumbnail?: boolean
  readonly templateName?: string
  readonly linkbackContext?: string
}

export interface LinkedinVideoUploadInstruction {
  readonly uploadUrl: string
  /** Inclusive byte offsets supplied by LinkedIn. */
  readonly firstByte: number
  readonly lastByte: number
}

export interface LinkedinVideoUploadSession {
  readonly video: LinkedinVideoUrn
  readonly uploadUrlsExpireAt: number
  readonly uploadInstructions: readonly LinkedinVideoUploadInstruction[]
  /** Opaque; an empty string is valid. */
  readonly uploadToken: string
  readonly captionsUploadUrl?: string
  readonly thumbnailUploadUrl?: string
}

export interface LinkedinFinalizeVideoUploadInput {
  readonly video: LinkedinVideoUrn
  readonly uploadToken: string
  /** ETags in the order of the initialization response's upload instructions. */
  readonly uploadedPartIds: readonly string[]
}

/** Uploads the video itself; use the low-level flow for optional captions/thumbnails. */
export interface LinkedinVideoUploadInput extends LinkedinInitializeImageUploadInput {
  readonly file: Blob
  readonly templateName?: string
  readonly linkbackContext?: string
}
