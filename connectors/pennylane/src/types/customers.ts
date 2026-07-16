import type {
  PennylaneCollectionLink,
  PennylaneCursorOptions,
  PennylaneEqualityFilterOperator,
  PennylaneIdReference,
  PennylaneIdSort,
  PennylaneLanguage,
  PennylaneListFilterOperator,
  PennylanePrefixFilterOperator,
  PennylaneScalarFilterOperator,
} from "./common"

/** Postal address used for billing and delivery. */
export interface PennylaneAddress {
  readonly address: string
  readonly postal_code: string
  readonly city: string
  readonly country_alpha2: string
}

export type PennylanePaymentCondition =
  | "upon_receipt"
  | "custom"
  | "7_days"
  | "15_days"
  | "30_days"
  | "30_days_end_of_month"
  | "45_days"
  | "45_days_end_of_month"
  | "60_days"

export type PennylaneCustomerType = "company" | "individual"

interface PennylaneCustomerBase {
  readonly id: number
  readonly name: string
  readonly emails: readonly string[]
  readonly billing_iban: string | null
  readonly payment_conditions: PennylanePaymentCondition
  readonly recipient: string | null
  readonly phone: string | null
  readonly reference: string | null
  readonly notes: string | null
  readonly ledger_account: PennylaneIdReference | null
  readonly billing_address: PennylaneAddress
  readonly delivery_address: PennylaneAddress
  readonly external_reference: string
  readonly billing_language: PennylaneLanguage
  readonly mandates: PennylaneCollectionLink
  readonly pro_account_mandates: PennylaneCollectionLink
  readonly contacts: PennylaneCollectionLink
  readonly created_at: string
  readonly updated_at: string
}

export interface PennylaneCompanyCustomer extends PennylaneCustomerBase {
  readonly customer_type: "company"
  readonly vat_number: string | null
  readonly reg_no: string | null
}

export interface PennylaneIndividualCustomer extends PennylaneCustomerBase {
  readonly customer_type: "individual"
  readonly first_name: string
  readonly last_name: string
}

/** Discriminated on `customer_type`; narrow before reading type-specific fields. */
export type PennylaneCustomer = PennylaneCompanyCustomer | PennylaneIndividualCustomer

// Customers pair each filterable field with a fixed operator subset.
export type PennylaneCustomerFilter =
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
      readonly field: "ledger_account_id"
      readonly operator: PennylaneEqualityFilterOperator
      readonly value: number
    }
  | {
      readonly field: "customer_type"
      readonly operator: PennylaneEqualityFilterOperator
      readonly value: PennylaneCustomerType
    }
  | {
      readonly field: "name"
      readonly operator: PennylanePrefixFilterOperator | "eq"
      readonly value: string
    }
  | {
      readonly field: "external_reference" | "reg_no"
      readonly operator: PennylaneEqualityFilterOperator
      readonly value: string
    }
  | {
      readonly field: "external_reference" | "reg_no"
      readonly operator: PennylaneListFilterOperator
      readonly value: readonly string[]
    }
  | {
      readonly field: "emails"
      readonly operator: "in"
      readonly value: readonly string[]
    }

export interface PennylaneCustomerListOptions extends PennylaneCursorOptions {
  readonly filter?: readonly PennylaneCustomerFilter[]
  readonly sort?: PennylaneIdSort
}

/** Ledger account referenced by its account number (not id) when writing a customer. */
export interface PennylaneLedgerAccountReference {
  readonly number: string
}

interface PennylaneCreateCustomerBase {
  readonly billing_address: PennylaneAddress
  readonly delivery_address?: PennylaneAddress
  readonly emails?: readonly string[]
  readonly phone?: string
  readonly billing_iban?: string
  readonly recipient?: string
  readonly reference?: string
  readonly notes?: string
  readonly external_reference?: string
  readonly payment_conditions?: PennylanePaymentCondition
  readonly billing_language?: PennylaneLanguage
  readonly ledger_account?: PennylaneLedgerAccountReference
}

export interface PennylaneCreateCompanyCustomerInput extends PennylaneCreateCustomerBase {
  readonly name: string
  readonly vat_number?: string
  readonly reg_no?: string
}

export interface PennylaneCreateIndividualCustomerInput extends PennylaneCreateCustomerBase {
  readonly first_name: string
  readonly last_name: string
}

export type PennylaneUpdateCompanyCustomerInput = Partial<PennylaneCreateCompanyCustomerInput>
export type PennylaneUpdateIndividualCustomerInput = Partial<PennylaneCreateIndividualCustomerInput>

export interface PennylaneCustomerContact {
  readonly id: number
  readonly first_name: string
  readonly last_name: string
  readonly role: string | null
  readonly email: string | null
  readonly telephone_number: string | null
  readonly mobile_number: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface PennylaneCustomerContactListOptions extends PennylaneCursorOptions {
  readonly sort?: PennylaneIdSort
}

export interface PennylaneCustomerCategory {
  readonly id: number
  readonly label: string
  /** Decimal weight within the category group, kept as a string. */
  readonly weight: string
  readonly category_group: PennylaneIdReference
  readonly analytical_code: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** One category assignment sent to the categorize endpoint. */
export interface PennylaneCategorizeInput {
  readonly id: number
  /** Decimal weight; weights within a category group must sum to 1. */
  readonly weight: string
}
