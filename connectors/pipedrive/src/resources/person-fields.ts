import type { PipedriveHttp } from "../http"
import type { PipedrivePersonField, PipedrivePersonFieldUpdateInput } from "../types"
import { type EditableFieldsResource, editableFieldsResource } from "./fields"

export function personFieldsResource(
  http: PipedriveHttp
): EditableFieldsResource<PipedrivePersonField, PipedrivePersonFieldUpdateInput> {
  return editableFieldsResource(http, "personFields", "person field code")
}
