import type { PipedriveHttp } from "../http"
import type { PipedriveOrganizationField } from "../types"
import { type FieldsResource, fieldsResource } from "./fields"

export function organizationFieldsResource(
  http: PipedriveHttp
): FieldsResource<PipedriveOrganizationField> {
  return fieldsResource(http, "organizationFields", "organization field code")
}
