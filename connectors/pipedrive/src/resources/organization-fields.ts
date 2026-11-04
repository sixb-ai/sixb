import type { PipedriveHttp } from "../http"
import type { PipedriveOrganizationField, PipedriveOrganizationFieldUpdateInput } from "../types"
import { type EditableFieldsResource, editableFieldsResource } from "./fields"

export function organizationFieldsResource(
  http: PipedriveHttp
): EditableFieldsResource<PipedriveOrganizationField, PipedriveOrganizationFieldUpdateInput> {
  return editableFieldsResource(http, "organizationFields", "organization field code")
}
