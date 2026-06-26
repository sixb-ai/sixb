import type { PipedriveHttp } from "../http"
import type { PipedriveProductField } from "../types"
import { type FieldsResource, fieldsResource } from "./fields"

export function productFieldsResource(http: PipedriveHttp): FieldsResource<PipedriveProductField> {
  return fieldsResource(http, "productFields", "product field code")
}
