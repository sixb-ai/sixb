import type { Http } from "../http"
import { pageParams } from "../pagination"
import type {
  CompanyCamPhoto,
  CompanyCamProject,
  ListProjectPhotosOptions,
  ListProjectsOptions,
} from "../types"
import { photoFilterParams } from "./photos"

export interface ProjectsResource {
  /** `GET /projects` */
  list(options?: ListProjectsOptions): Promise<CompanyCamProject[]>
  /** `GET /projects/{id}` */
  get(id: string): Promise<CompanyCamProject>
  /** `GET /projects/{id}/photos` */
  listPhotos(projectId: string, options?: ListProjectPhotosOptions): Promise<CompanyCamPhoto[]>
}

export function projectsResource(http: Http): ProjectsResource {
  return {
    list(options) {
      return http.get<CompanyCamProject[]>("projects", {
        ...pageParams(options),
        query: options?.query,
        modified_since: options?.modifiedSince,
      })
    },
    get(id) {
      return http.get<CompanyCamProject>(`projects/${id}`)
    },
    listPhotos(projectId, options) {
      return http.get<CompanyCamPhoto[]>(`projects/${projectId}/photos`, photoFilterParams(options))
    },
  }
}
