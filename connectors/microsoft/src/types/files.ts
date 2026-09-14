import type { GraphPage, IdentitySet, RequestOptions, SelectOptions } from "./common"

/** Properties may be absent when $select is used, or on delta tombstones. */
export interface Site {
  readonly id: string
  readonly name?: string
  readonly displayName?: string
  readonly description?: string
  readonly webUrl?: string
  readonly createdDateTime?: string
  readonly lastModifiedDateTime?: string
  readonly siteCollection?: { readonly hostname?: string }
}

export interface Drive {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly driveType?: "personal" | "business" | "documentLibrary"
  readonly webUrl?: string
  readonly owner?: IdentitySet
  readonly createdDateTime?: string
  readonly lastModifiedDateTime?: string
  readonly quota?: {
    readonly total?: number
    readonly used?: number
    readonly remaining?: number
    readonly deleted?: number
    readonly state?: string
  }
}

export interface ItemReference {
  readonly driveId?: string
  readonly driveType?: string
  readonly id?: string
  readonly path?: string
  readonly siteId?: string
}

export interface DriveItem {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly size?: number
  readonly webUrl?: string
  readonly eTag?: string
  readonly cTag?: string
  readonly createdDateTime?: string
  readonly lastModifiedDateTime?: string
  readonly createdBy?: IdentitySet
  readonly lastModifiedBy?: IdentitySet
  readonly parentReference?: ItemReference
  readonly file?: {
    readonly mimeType?: string
    readonly hashes?: {
      readonly quickXorHash?: string
      readonly sha1Hash?: string
      readonly sha256Hash?: string
      readonly crc32Hash?: string
    }
  }
  readonly folder?: { readonly childCount?: number }
  readonly deleted?: { readonly state?: string }
  readonly fileSystemInfo?: {
    readonly createdDateTime?: string
    readonly lastModifiedDateTime?: string
  }
  readonly remoteItem?: RemoteItem
  readonly sharepointIds?: {
    readonly siteId?: string
    readonly webId?: string
    readonly listId?: string
    readonly listItemId?: string
    readonly listItemUniqueId?: string
    readonly siteUrl?: string
    readonly tenantId?: string
  }
  /** Short-lived credential-bearing URL; never persist or log it. */
  readonly "@microsoft.graph.downloadUrl"?: string
}

/** The remoteItem facet is a separate Graph resource, not a nested driveItem. */
export type RemoteItem = Partial<
  Pick<
    DriveItem,
    | "id"
    | "name"
    | "size"
    | "webUrl"
    | "createdDateTime"
    | "lastModifiedDateTime"
    | "createdBy"
    | "lastModifiedBy"
    | "parentReference"
    | "file"
    | "folder"
    | "fileSystemInfo"
    | "sharepointIds"
  >
>

export interface DeltaPage extends GraphPage<DriveItem> {
  readonly "@odata.deltaLink"?: string
}

export interface DeltaOptions extends SelectOptions {
  readonly top?: number
  /** A previous nextLink/deltaLink. Passed to Graph unchanged. */
  readonly cursor?: string
  /** Obtain a checkpoint without enumerating existing files. */
  readonly token?: "latest"
}

export interface UploadSession {
  /** A credential-bearing URL. Store securely if persisting an interrupted upload. */
  readonly uploadUrl: string
  readonly expirationDateTime: string
  readonly nextExpectedRanges?: readonly string[]
}

export interface UploadStatus {
  readonly expirationDateTime: string
  readonly nextExpectedRanges: readonly string[]
}

/** Blob includes Bun.file(), allowing large uploads without buffering the whole file. */
export type FileContent = Blob | Uint8Array | ArrayBuffer

export interface UploadTransferOptions extends RequestOptions {
  /** Positive multiple of 320 KiB, strictly below 60 MiB. Defaults to 10 MiB. */
  readonly chunkSize?: number
}
