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
