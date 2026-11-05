import type { FleetioHttp } from "../http"
import type {
  FleetioComment,
  FleetioCommentCreateInput,
  FleetioCommentFilter,
  FleetioCommentSort,
  FleetioCommentSummary,
  FleetioCommentUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type CommentsResource = FleetioReadMethods<
  FleetioCommentSummary,
  FleetioComment,
  FleetioCommentFilter,
  FleetioCommentSort
> &
  FleetioWriteMethods<
    FleetioCommentCreateInput,
    FleetioComment,
    FleetioCommentUpdateInput,
    FleetioComment
  >

export function commentsResource(http: FleetioHttp): CommentsResource {
  return {
    ...readMethods(http, "comments", "comment id"),
    ...writeMethods(http, "comments", "comment id"),
  }
}
