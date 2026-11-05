import type { FleetioEqFilter, FleetioSortDirection } from "./common"
import type { FleetioCommentableType, FleetioContactMini } from "./shared"

/** A Comment */
export interface FleetioComment {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The type of record that the Comment will be left on. */
  readonly commentable_type: FleetioCommentableType
  readonly commentable_id: number
  readonly user_id: number
  /** @deprecated The title of the Comment. */
  readonly title?: string
  /** The content of the Comment message body. */
  readonly comment: string
  /** The full name of the `User` who created the Comment. */
  readonly user_full_name: string
  /** The image url for the `User` who created the Comment. */
  readonly user_image_url: string | null
  readonly rich_content: Readonly<Record<string, unknown>> | null
  /** The comment message body rendered as HTML. */
  readonly html_content: string | null
  /** Indicates if the message body contains @mentions. */
  readonly with_mentions: boolean
}

/** A Comment */
export interface FleetioCommentSummary {
  readonly id: number
  readonly created_at?: string
  readonly updated_at?: string
  /** The type of record that the Comment will be left on. */
  readonly commentable_type: FleetioCommentableType
  readonly commentable_id: number
  readonly user_id: number
  /** The content of the Comment message body. */
  readonly comment: string
  readonly rich_content: Readonly<Record<string, unknown>> | null
  /** The comment message body rendered as HTML. */
  readonly html_content: string | null
  /** Indicates if the message body contains @mentions. */
  readonly with_mentions: boolean
  /** A Contact */
  readonly author?: FleetioContactMini | null
}

export interface FleetioCommentFilter {
  readonly commentable_id?: FleetioEqFilter
  readonly commentable_type?: FleetioEqFilter
  readonly user_id?: FleetioEqFilter
}

export interface FleetioCommentSort {
  readonly id?: FleetioSortDirection
  readonly updated_at?: FleetioSortDirection
}

export interface FleetioCommentCreateInput {
  /** @deprecated The title of the Comment. */
  readonly title?: string
  /** The content of the Comment message body. */
  readonly comment: string
  /** The type of record that the Comment will be left on. */
  readonly commentable_type: FleetioCommentableType
  readonly commentable_id: number
}

export type FleetioCommentUpdateInput = Partial<FleetioCommentCreateInput>
