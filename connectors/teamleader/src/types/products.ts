import type { TeamleaderMoney, TeamleaderPage, TeamleaderTypeAndId } from "./common"
import type { TeamleaderCustomField, TeamleaderCustomFieldInput } from "./custom-fields"

export interface TeamleaderProductListRequest {
  readonly filter?: {
    readonly ids?: readonly string[]
    readonly term?: string
    readonly updated_since?: string
  }
  readonly page?: TeamleaderPage
}

export interface TeamleaderProductInfoRequest {
  readonly id: string
  /** Comma-separated list of optional includes. Documented value: `suppliers`. */
  readonly includes?: string
}

export type TeamleaderProductAddRequest =
  | (TeamleaderProductAddFields & { readonly name: string; readonly code?: string })
  | (TeamleaderProductAddFields & { readonly code: string; readonly name?: string })

export interface TeamleaderProductAddFields {
  readonly description?: string
  readonly purchase_price?: TeamleaderMoney | null
  readonly selling_price?: TeamleaderMoney | null
  readonly unit_of_measure_id?: string | null
  readonly price_list_prices?: readonly TeamleaderProductPriceListPriceInput[]
  readonly stock?: TeamleaderProductStock
  readonly configuration?: TeamleaderProductConfiguration | null
  readonly department_id?: string
  readonly product_category_id?: string
  readonly tax_rate_id?: string
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
}

export interface TeamleaderProductUpdateRequest {
  readonly id: string
  readonly name?: string | null
  readonly code?: string | null
  readonly description?: string | null
  readonly purchase_price?: TeamleaderMoney | null
  readonly selling_price?: TeamleaderMoney | null
  readonly unit_of_measure_id?: string | null
  readonly price_list_prices?: readonly TeamleaderProductPriceListPriceInput[]
  readonly stock?: TeamleaderProductStock
  readonly configuration?: TeamleaderProductConfiguration | null
  readonly department_id?: string
  readonly product_category_id?: string
  readonly tax_rate_id?: string
  readonly custom_fields?: readonly TeamleaderCustomFieldInput[]
}

export interface TeamleaderProductListItem {
  readonly id: string
  readonly name?: string | null
  readonly description?: string | null
  readonly code?: string | null
  readonly unit?: TeamleaderTypeAndId<"unitOfMeasure"> | null
  readonly added_at?: string
  readonly updated_at?: string
  readonly stock?: TeamleaderProductStock
  readonly configuration?: TeamleaderProductConfiguration | null
}

export interface TeamleaderProduct extends TeamleaderProductListItem {
  readonly purchase_price?: TeamleaderMoney | null
  readonly selling_price?: TeamleaderMoney | null
  readonly tax?: TeamleaderTypeAndId<"taxRate"> | null
  readonly suppliers?: readonly TeamleaderProductSupplier[]
  readonly custom_fields?: readonly TeamleaderCustomField[]
  readonly price_list_prices?: readonly TeamleaderProductPriceListPrice[]
  readonly product_category?: TeamleaderTypeAndId<"productCategory"> | null
}

export interface TeamleaderProductStock {
  readonly amount?: number | null
}

export interface TeamleaderProductConfiguration {
  readonly stock_threshold?: {
    readonly minimum?: number
    readonly action?: "notify"
  } | null
}

export interface TeamleaderProductSupplier {
  readonly supplier?: TeamleaderTypeAndId<"company" | "contact">
  readonly purchase_price?: TeamleaderMoney | null
  readonly product_code?: string
  readonly minimum_order_amount?: number
  readonly classification?: "primary" | "secondary"
}

export interface TeamleaderProductPriceListPrice {
  readonly price_list?: TeamleaderTypeAndId<"priceList">
  readonly price?: TeamleaderMoney
}

export interface TeamleaderProductPriceListPriceInput {
  readonly price_list_id: string
  readonly price: TeamleaderMoney
}
