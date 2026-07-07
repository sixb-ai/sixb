import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedrivePerson,
  PipedrivePersonGetOptions,
  PipedrivePersonInput,
  PipedrivePersonListOptions,
  PipedrivePersonSearchOptions,
  PipedriveResponse,
  PipedriveSearchResponse,
} from "../types"

export interface PersonsResource {
  /** `GET /persons` */
  list(options?: PipedrivePersonListOptions): Promise<PipedriveCursorPage<PipedrivePerson>>
  listAll(options?: PipedrivePersonListOptions): AsyncIterable<PipedrivePerson>
  /** `POST /persons` */
  create(input: PipedrivePersonInput): Promise<PipedriveResponse<PipedrivePerson>>
  /** `GET /persons/{id}` */
  get(id: number, options?: PipedrivePersonGetOptions): Promise<PipedriveResponse<PipedrivePerson>>
  /** `PATCH /persons/{id}` */
  update(
    id: number,
    input: Partial<PipedrivePersonInput>
  ): Promise<PipedriveResponse<PipedrivePerson>>
  /** `GET /persons/search` */
  search(options: PipedrivePersonSearchOptions): Promise<PipedriveSearchResponse>
}

export function personsResource(http: PipedriveHttp): PersonsResource {
  const resource: PersonsResource = {
    list(options) {
      return http.get("v2", "persons", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    create(input) {
      return http.post("v2", "persons", input)
    },
    get(id, options) {
      return http.get("v2", `persons/${pathPart(id, "person id")}`, options)
    },
    update(id, input) {
      return http.patch("v2", `persons/${pathPart(id, "person id")}`, input)
    },
    search(options) {
      return http.get("v2", "persons/search", options)
    },
  }

  return resource
}
