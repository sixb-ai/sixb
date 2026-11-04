import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveField,
  PipedriveFieldCreateInput,
  PipedriveFieldGetOptions,
  PipedriveFieldListOptions,
  PipedriveFieldOptionAddInput,
  PipedriveFieldOptionDeleteInput,
  PipedriveFieldOptionsResponse,
  PipedriveFieldOptionUpdateInput,
  PipedriveResponse,
} from "../types"

export interface FieldsResource<TField extends PipedriveField = PipedriveField> {
  /** `GET /{entity}Fields` */
  list(options?: PipedriveFieldListOptions): Promise<PipedriveCursorPage<TField>>
  listAll(options?: PipedriveFieldListOptions): AsyncIterable<TField>
  /** `GET /{entity}Fields/{field_code}` */
  get(
    fieldCode: string,
    options?: PipedriveFieldGetOptions
  ): Promise<PipedriveResponse<TField, null>>
}

/** The field calls Pipedrive offers on persons, organizations, deals and products. */
export interface EditableFieldsResource<TField extends PipedriveField, TUpdate>
  extends FieldsResource<TField> {
  /** `POST /{entity}Fields` */
  create(input: PipedriveFieldCreateInput<TUpdate>): Promise<PipedriveResponse<TField, null>>
  /** `PATCH /{entity}Fields/{field_code}` */
  update(fieldCode: string, input: TUpdate): Promise<PipedriveResponse<TField, null>>
  /** `DELETE /{entity}Fields/{field_code}` */
  delete(fieldCode: string): Promise<PipedriveResponse<TField, null>>
  /** `POST /{entity}Fields/{field_code}/options`. All are added or none are. */
  addOptions(
    fieldCode: string,
    options: readonly PipedriveFieldOptionAddInput[]
  ): Promise<PipedriveFieldOptionsResponse>
  /** `PATCH /{entity}Fields/{field_code}/options`. Fails entirely if any id does not exist. */
  updateOptions(
    fieldCode: string,
    options: readonly PipedriveFieldOptionUpdateInput[]
  ): Promise<PipedriveFieldOptionsResponse>
  /** `DELETE /{entity}Fields/{field_code}/options`. Fails entirely if any id does not exist. */
  deleteOptions(
    fieldCode: string,
    options: readonly PipedriveFieldOptionDeleteInput[]
  ): Promise<PipedriveFieldOptionsResponse>
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
    get(fieldCode, options) {
      return http.get("v2", `${path}/${pathPart(fieldCode, fieldName)}`, options)
    },
  }

  return resource
}

export function editableFieldsResource<TField extends PipedriveField, TUpdate>(
  http: PipedriveHttp,
  path: string,
  fieldName: string
): EditableFieldsResource<TField, TUpdate> {
  const fieldPath = (fieldCode: string) => `${path}/${pathPart(fieldCode, fieldName)}`
  const optionsPath = (fieldCode: string) => `${fieldPath(fieldCode)}/options`

  return {
    ...fieldsResource<TField>(http, path, fieldName),
    create(input) {
      return http.post("v2", path, input)
    },
    update(fieldCode, input) {
      return http.patch("v2", fieldPath(fieldCode), input)
    },
    delete(fieldCode) {
      return http.delete("v2", fieldPath(fieldCode))
    },
    addOptions(fieldCode, options) {
      return http.post("v2", optionsPath(fieldCode), nonEmptyOptions(options))
    },
    updateOptions(fieldCode, options) {
      return http.patch("v2", optionsPath(fieldCode), nonEmptyOptions(options))
    },
    deleteOptions(fieldCode, options) {
      return http.delete("v2", optionsPath(fieldCode), nonEmptyOptions(options))
    },
  }
}

function nonEmptyOptions<T>(options: readonly T[]): readonly T[] {
  if (options.length === 0) {
    throw new Error("[SixbPipedrive] options must contain at least one item.")
  }

  return options
}
