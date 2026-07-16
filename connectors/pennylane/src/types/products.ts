import type {
  PennylaneCurrency,
  PennylaneCursorOptions,
  PennylaneEqualityFilterOperator,
  PennylaneIdReference,
  PennylaneIdSort,
  PennylaneListFilterOperator,
  PennylaneScalarFilterOperator,
  PennylaneVatRate,
} from "./common"

export interface PennylaneProduct {
  readonly id: number
  readonly label: string
  readonly description: string | null
  readonly unit: string | null
  /** Product reference/SKU. */
  readonly reference: string | null
  readonly external_reference: string
  readonly currency: PennylaneCurrency
  /** Decimal price excluding tax, kept as a string to avoid float rounding. */
  readonly price_before_tax: string
  /** Decimal price including tax. */
  readonly price: string
  readonly vat_rate: PennylaneVatRate
  readonly ledger_account: PennylaneIdReference | null
  readonly archived_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

// Products pair each filterable field with a fixed operator subset.
export type PennylaneProductFilter =
  | {
      readonly field: "id"
      readonly operator: PennylaneScalarFilterOperator
      readonly value: number
    }
  | {
      readonly field: "id"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly number[]
    }
  | {
      readonly field: "label" | "reference"
      readonly operator: "eq"
      readonly value: string
    }
  | {
      readonly field: "label" | "reference"
      readonly operator: "in"
      readonly value: readonly string[]
    }
  | {
      readonly field: "external_reference"
      readonly operator: PennylaneEqualityFilterOperator
      readonly value: string
    }
  | {
      readonly field: "external_reference"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly string[]
    }

export interface PennylaneProductListOptions extends PennylaneCursorOptions {
  readonly filter?: readonly PennylaneProductFilter[]
  readonly sort?: PennylaneIdSort
}

export interface PennylaneCreateProductInput {
  readonly label: string
  readonly price_before_tax: string
  readonly vat_rate: PennylaneVatRate
  readonly description?: string
  readonly unit?: string
  readonly currency?: PennylaneCurrency
  readonly reference?: string
  readonly external_reference?: string
  /** Ledger account referenced by id on write (products only). */
  readonly ledger_account_id?: number
}

export type PennylaneUpdateProductInput = Partial<PennylaneCreateProductInput>
