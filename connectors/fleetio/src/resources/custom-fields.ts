import type { FleetioHttp } from "../http"
import type { FleetioCustomField, FleetioCustomFieldFilter, FleetioCustomFieldSort } from "../types"
import { type FleetioListMethods, listMethods } from "./crud"

/** The custom field definitions on the account. Fleetio has no call to fetch one by ID. */
export type CustomFieldsResource = FleetioListMethods<
  FleetioCustomField,
  FleetioCustomFieldFilter,
  FleetioCustomFieldSort
>

export function customFieldsResource(http: FleetioHttp): CustomFieldsResource {
  return listMethods(http, "custom_fields")
}
