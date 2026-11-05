import type { FleetioHttp } from "../http"
import type {
  FleetioGroup,
  FleetioGroupCreated,
  FleetioGroupCreateInput,
  FleetioGroupFilter,
  FleetioGroupSort,
  FleetioGroupUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type GroupsResource = FleetioReadMethods<
  FleetioGroup,
  FleetioGroup,
  FleetioGroupFilter,
  FleetioGroupSort
> &
  FleetioWriteMethods<FleetioGroupCreateInput, FleetioGroupCreated, FleetioGroupUpdateInput>

export function groupsResource(http: FleetioHttp): GroupsResource {
  return {
    ...readMethods(http, "groups", "group id"),
    ...writeMethods(http, "groups", "group id"),
  }
}
