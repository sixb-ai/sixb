import type { TeamleaderPage, TeamleaderSort, TeamleaderTypeAndId } from "./common"

export type TeamleaderCustomFieldObjectValue = TeamleaderTypeAndId<
  "company" | "contact" | "product" | "user"
>

export type TeamleaderCustomFieldValue =
  | string
  | number
  | readonly string[]
  | boolean
  | TeamleaderCustomFieldObjectValue

export interface TeamleaderCustomField {
  readonly definition: TeamleaderTypeAndId<"customFieldDefinition">
  readonly value: TeamleaderCustomFieldValue
}

export interface TeamleaderCustomFieldInput {
  readonly id: string
  readonly value: TeamleaderCustomFieldValue
}

export type TeamleaderCustomFieldDefinitionContext =
  | "contact"
  | "company"
  | "deal"
  | "sale"
  | "project"
  | "milestone"
  | "product"
  | "invoice"
  | "subscription"
  | "ticket"

export type TeamleaderCustomFieldDefinitionType =
  | "single_line"
  | "multi_line"
  | "single_select"
  | "multi_select"
  | "date"
  | "money"
  | "auto_increment"
  | "integer"
  | "number"
  | "boolean"
  | "email"
  | "telephone"
  | "url"
  | "company"
  | "contact"
  | "product"
  | "user"

export interface TeamleaderCustomFieldDefinition {
  readonly id: string
  readonly context?: TeamleaderCustomFieldDefinitionContext
  readonly type?: TeamleaderCustomFieldDefinitionType
  readonly label?: string
  readonly group?: string
  readonly required?: boolean
  readonly configuration?: {
    readonly options?: readonly {
      readonly id?: string
      readonly value?: string
    }[]
    readonly extra_option_allowed?: boolean
  }
}

export interface TeamleaderCustomFieldDefinitionListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
    readonly context?: TeamleaderCustomFieldDefinitionContext
  }
  readonly page?: TeamleaderPage
  readonly sort?: readonly TeamleaderSort<"label" | "context">[]
}
