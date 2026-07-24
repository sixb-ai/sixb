import type {
  PennylaneCursorOptions,
  PennylaneCursorPage,
  PennylaneIdSort,
  PennylaneListFilterOperator,
  PennylaneScalarFilterOperator,
  PennylaneVatRate,
} from "./common"

/** One account from Pennylane's general ledger chart. */
export interface PennylaneLedgerAccount {
  readonly id: number
  readonly number: string
  readonly label: string
  readonly vat_rate: PennylaneVatRate
  readonly country_alpha2: string
  readonly enabled: boolean
  /** Pennylane currently returns values such as `custom` but does not document a closed enum. */
  readonly type: string
  readonly letterable: boolean
  readonly created_at: string
  readonly updated_at: string
}

// Ledger accounts pair each filterable field with a fixed operator subset.
export type PennylaneLedgerAccountFilter =
  | {
      readonly field: "id"
      readonly operator: PennylaneScalarFilterOperator
      readonly value: number | string
    }
  | {
      readonly field: "id"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly (number | string)[]
    }
  | {
      readonly field: "number"
      readonly operator: "start_with" | "eq"
      readonly value: string
    }
  | {
      readonly field: "number"
      readonly operator: "in"
      readonly value: readonly string[]
    }
  | {
      readonly field: "enabled"
      readonly operator: "eq"
      readonly value: boolean
    }

export interface PennylaneLedgerAccountListOptions extends PennylaneCursorOptions {
  readonly filter?: readonly PennylaneLedgerAccountFilter[]
  readonly sort?: PennylaneIdSort
}

/**
 * Pennylane documents `has_more` as nullable for this endpoint. `null` is terminal, like `false`.
 */
export type PennylaneLedgerAccountPage = PennylaneCursorPage<PennylaneLedgerAccount, boolean | null>

export interface PennylaneCreateLedgerAccountInput {
  /** Account number. Pennylane requires a non-empty value containing no whitespace. */
  readonly number: string
  readonly label: string
  readonly vat_rate?: PennylaneVatRate
  readonly country_alpha2?: string
}

/** Only the label and letterable flag are writable on an existing account. */
export interface PennylaneUpdateLedgerAccountInput {
  readonly label?: string
  readonly letterable?: boolean
}
