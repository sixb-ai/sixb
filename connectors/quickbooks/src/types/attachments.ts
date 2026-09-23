import type { QuickBooksEntity } from "./entities"
import type { QuickBooksPaginationOptions } from "./query"

export interface QuickBooksAttachmentEntityRef {
  readonly type: string
  readonly value: string
}

export interface QuickBooksAttachmentRef {
  readonly EntityRef: QuickBooksAttachmentEntityRef
  readonly IncludeOnSend?: boolean
}

export interface QuickBooksAttachment extends QuickBooksEntity {
  readonly FileName?: string
  readonly ContentType?: string
  readonly Size?: number
  readonly Note?: string
  readonly AttachableRef?: readonly QuickBooksAttachmentRef[]
  readonly FileAccessUri?: string
  readonly TempDownloadUri?: string
  readonly ThumbnailFileAccessUri?: string
  readonly ThumbnailTempDownloadUri?: string
}

export interface QuickBooksAttachmentListOptions extends QuickBooksPaginationOptions {
  /** Only attachments linked to this entity. */
  readonly entity?: QuickBooksAttachmentEntityRef
}

/** Upload one file, optionally linking it to existing QuickBooks entities. */
export interface QuickBooksAttachmentUpload {
  readonly file: Blob
  readonly FileName: string
  /** Defaults to file.type; required when the Blob has no media type. */
  readonly ContentType?: string
  readonly Note?: string
  readonly AttachableRef?: readonly QuickBooksAttachmentRef[]
}
