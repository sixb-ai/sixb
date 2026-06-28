import type { PandaDocJsonObject, QueryValue } from "./common"

export interface PandaDocCatalogItemSearchOptions {
  readonly [key: string]: QueryValue
  readonly page?: number
  readonly per_page?: number
  readonly query?: string
  readonly types?: readonly string[]
  readonly billing_types?: readonly string[]
  readonly category_id?: string
  readonly exclude_uuids?: readonly string[]
  readonly order_by?: string
}

export interface PandaDocCatalogItem extends PandaDocJsonObject {
  readonly uuid?: string
  readonly id?: string
  readonly name?: string
  readonly sku?: string
}

export interface PandaDocCatalogItemInput extends PandaDocJsonObject {}
