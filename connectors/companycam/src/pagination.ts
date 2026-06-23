import type { QueryParams } from "./http"
import type { PageOptions } from "./types"

/**
 * Map offset pagination options to CompanyCam's `page` / `per_page` query params.
 * Only emits a param when the caller provides it (defaults to the API's own).
 */
export function pageParams(options?: PageOptions): QueryParams {
  return {
    page: options?.page,
    per_page: options?.perPage,
  }
}
