import type { PipedriveHttp } from "../http"
import type { PipedriveDealField } from "../types"
import { type FieldsResource, fieldsResource } from "./fields"

export function dealFieldsResource(http: PipedriveHttp): FieldsResource<PipedriveDealField> {
  return fieldsResource(http, "dealFields", "deal field code")
}
