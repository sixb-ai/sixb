import type { PipedriveHttp } from "../http"
import type { PipedriveDealField, PipedriveDealFieldUpdateInput } from "../types"
import { type EditableFieldsResource, editableFieldsResource } from "./fields"

export function dealFieldsResource(
  http: PipedriveHttp
): EditableFieldsResource<PipedriveDealField, PipedriveDealFieldUpdateInput> {
  return editableFieldsResource(http, "dealFields", "deal field code")
}
