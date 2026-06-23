import type { CompanyCamCoordinate, CompanyCamImageUri, PageOptions } from "./common"

export interface CompanyCamPhoto {
  readonly id: string
  readonly company_id: string
  readonly creator_id: string
  readonly creator_type: string
  readonly creator_name: string
  readonly project_id: string
  readonly processing_status: string
  readonly status: string
  readonly coordinates: CompanyCamCoordinate | null
  readonly uris: readonly CompanyCamImageUri[]
  readonly hash: string
  readonly description: string | null
  readonly internal: boolean
  readonly photo_url: string
  /** Unix epoch seconds. */
  readonly captured_at: number
  /** Unix epoch seconds. */
  readonly created_at: number
  /** Unix epoch seconds. */
  readonly updated_at: number
}

/** Filters shared by `projects.listPhotos` and `photos.list`. */
export interface ListProjectPhotosOptions extends PageOptions {
  /** Only photos captured at or after this Unix timestamp. */
  readonly startDate?: number
  /** Only photos captured at or before this Unix timestamp. */
  readonly endDate?: number
  readonly userIds?: readonly string[]
  readonly groupIds?: readonly string[]
  readonly tagIds?: readonly string[]
}

export interface ListPhotosOptions extends ListProjectPhotosOptions {
  readonly projectIds?: readonly string[]
}
