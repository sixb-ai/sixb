/** Offset pagination, shared by every list endpoint. */
export interface PageOptions {
  /** 1-based page number (defaults to CompanyCam's first page). */
  readonly page?: number
  /** Results per page, 1-100 (defaults to CompanyCam's 50). */
  readonly perPage?: number
}

export interface CompanyCamCoordinate {
  readonly lat: number
  readonly lon: number
}

/**
 * One image variant. `type` is `"original" | "web" | "thumbnail"` in practice,
 * but CompanyCam does not declare the set as exhaustive.
 */
export interface CompanyCamImageUri {
  readonly type: string
  readonly uri: string
  readonly url?: string
}
