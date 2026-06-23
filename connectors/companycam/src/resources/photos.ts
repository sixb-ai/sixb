import type { Http, QueryParams } from "../http"
import { pageParams } from "../pagination"
import type { CompanyCamPhoto, ListPhotosOptions, ListProjectPhotosOptions } from "../types"

export interface PhotosResource {
  /** `GET /photos` — photos across all projects. */
  list(options?: ListPhotosOptions): Promise<CompanyCamPhoto[]>
  /** `GET /photos/{id}` */
  get(id: string): Promise<CompanyCamPhoto>
}

export function photosResource(http: Http): PhotosResource {
  return {
    list(options) {
      return http.get<CompanyCamPhoto[]>("photos", {
        ...photoFilterParams(options),
        project_ids: options?.projectIds,
      })
    },
    get(id) {
      return http.get<CompanyCamPhoto>(`photos/${id}`)
    },
  }
}

/** Shared by `photos.list` and `projects.listPhotos`. */
export function photoFilterParams(options?: ListProjectPhotosOptions): QueryParams {
  return {
    ...pageParams(options),
    start_date: options?.startDate,
    end_date: options?.endDate,
    user_ids: options?.userIds,
    group_ids: options?.groupIds,
    tag_ids: options?.tagIds,
  }
}
