import type { FleetioHttp } from "../http"
import type {
  FleetioIssuePriority,
  FleetioIssuePriorityFilter,
  FleetioIssuePrioritySort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type IssuePrioritiesResource = FleetioReadMethods<
  FleetioIssuePriority,
  FleetioIssuePriority,
  FleetioIssuePriorityFilter,
  FleetioIssuePrioritySort
>

export function issuePrioritiesResource(http: FleetioHttp): IssuePrioritiesResource {
  return readMethods(http, "issue_priorities", "issue priority id")
}
