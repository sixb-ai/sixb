import type { PipedriveHttp } from "../http"
import type { PipedriveActivityField } from "../types"
import { type FieldsResource, fieldsResource } from "./fields"

export function activityFieldsResource(
  http: PipedriveHttp
): FieldsResource<PipedriveActivityField> {
  return fieldsResource(http, "activityFields", "activity field code")
}
