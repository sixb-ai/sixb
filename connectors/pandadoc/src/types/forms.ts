import type { PandaDocJsonObject, PandaDocPageOptions } from "./common"

export interface PandaDocFormListOptions extends PandaDocPageOptions {
  readonly status?: readonly ("draft" | "active" | "disabled" | (string & {}))[]
  readonly order_by?: "name" | "responses" | "status" | "created_date" | "modified_date" | string
  readonly asc?: boolean
  readonly name?: string
}

export interface PandaDocForm extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly name?: string
  readonly status?: string
}
