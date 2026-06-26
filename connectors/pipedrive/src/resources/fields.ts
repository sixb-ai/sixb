import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveField,
  PipedriveFieldListOptions,
  PipedriveResponse,
} from "../types"

export interface FieldsResource<TField extends PipedriveField = PipedriveField> {
  list(options?: PipedriveFieldListOptions): Promise<PipedriveCursorPage<TField>>
  listAll(options?: PipedriveFieldListOptions): AsyncIterable<TField>
  get(fieldCode: string): Promise<PipedriveResponse<TField>>
}

export function fieldsResource<TField extends PipedriveField>(
  http: PipedriveHttp,
  path: string,
  fieldName: string
): FieldsResource<TField> {
  const resource: FieldsResource<TField> = {
    list(options) {
      return http.get("v2", path, options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(fieldCode) {
      return http.get("v2", `${path}/${pathPart(fieldCode, fieldName)}`)
    },
  }

  return resource
}
