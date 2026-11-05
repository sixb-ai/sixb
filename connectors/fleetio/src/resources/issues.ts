import type { FleetioHttp } from "../http"
import type {
  FleetioId,
  FleetioIssue,
  FleetioIssueCloseInput,
  FleetioIssueCreateInput,
  FleetioIssueFilter,
  FleetioIssueResolveInput,
  FleetioIssueSort,
  FleetioIssueSummary,
  FleetioIssueUpdateInput,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioListMethods,
  type FleetioWriteMethods,
  listMethods,
  writeMethods,
} from "./crud"

export type FleetioIssueInclude =
  | "asset"
  | "comments"
  | "custom_fields"
  | "documents"
  | "images"
  | "labels"

export interface FleetioIssueGetOptions {
  /** Additional attributes to return with the issue. */
  readonly includes?: readonly FleetioIssueInclude[]
}

export type IssuesResource = FleetioListMethods<
  FleetioIssueSummary,
  FleetioIssueFilter,
  FleetioIssueSort
> &
  FleetioWriteMethods<
    FleetioIssueCreateInput,
    FleetioIssue,
    FleetioIssueUpdateInput,
    FleetioIssue
  > & {
    get(id: FleetioId, options?: FleetioIssueGetOptions): Promise<FleetioIssue>
    /** `PUT /issues/{id}/close` */
    close(id: FleetioId, input: FleetioIssueCloseInput): Promise<FleetioIssue>
    /** `PUT /issues/{id}/resolve` */
    resolve(id: FleetioId, input: FleetioIssueResolveInput): Promise<FleetioIssue>
    /** `PUT /issues/{id}/reopen` */
    reopen(id: FleetioId): Promise<FleetioIssue>
  }

export function issuesResource(http: FleetioHttp): IssuesResource {
  const issuePath = (id: FleetioId) => `issues/${pathId(id, "issue id")}`

  return {
    ...listMethods(http, "issues"),
    ...writeMethods(http, "issues", "issue id"),
    get(id, options) {
      return http.get(issuePath(id), { includes: options?.includes?.join(",") })
    },
    close(id, input) {
      return http.put(`${issuePath(id)}/close`, input)
    },
    resolve(id, input) {
      return http.put(`${issuePath(id)}/resolve`, input)
    },
    reopen(id) {
      return http.put(`${issuePath(id)}/reopen`)
    },
  }
}
