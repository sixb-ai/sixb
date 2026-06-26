import type { PipedriveHttp } from "../http"
import type { PipedrivePersonField } from "../types"
import { type FieldsResource, fieldsResource } from "./fields"

export function personFieldsResource(http: PipedriveHttp): FieldsResource<PipedrivePersonField> {
  return fieldsResource(http, "personFields", "person field code")
}
