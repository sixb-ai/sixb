import type { PipedriveHttp } from "../http"
import type { PipedriveProductField, PipedriveProductFieldUpdateInput } from "../types"
import { type EditableFieldsResource, editableFieldsResource } from "./fields"

export function productFieldsResource(
  http: PipedriveHttp
): EditableFieldsResource<PipedriveProductField, PipedriveProductFieldUpdateInput> {
  return editableFieldsResource(http, "productFields", "product field code")
}
