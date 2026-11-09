import type { QuickBooksEntity, QuickBooksReference } from "./entities"

export interface QuickBooksTaxRateList {
  readonly TaxRateDetail?: readonly {
    readonly TaxRateRef?: QuickBooksReference
    readonly TaxTypeApplicable?: string
    readonly TaxOrder?: number
    readonly TaxOnTaxOrder?: number
  }[]
}

/**
 * Read-only. US pseudo-codes (`TAX`, `NON`, `CustomSalesTax`) have no Active flag or numeric
 * ID: they cannot be read by ID and are not returned by Active-filtered queries.
 */
export interface QuickBooksTaxCode extends QuickBooksEntity {
  readonly Name: string
  readonly Description?: string
  readonly Active?: boolean
  readonly Hidden?: boolean
  readonly Taxable?: boolean
  readonly TaxGroup?: boolean
  readonly SalesTaxRateList?: QuickBooksTaxRateList
  readonly PurchaseTaxRateList?: QuickBooksTaxRateList
  readonly TaxCodeConfigType?: string
}

export interface QuickBooksTaxRate extends QuickBooksEntity {
  readonly Name: string
  readonly Description?: string
  readonly Active?: boolean
  readonly RateValue?: number
  readonly AgencyRef?: QuickBooksReference
  readonly TaxReturnLineRef?: QuickBooksReference
  readonly SpecialTaxType?: string
  readonly DisplayType?: string
  readonly EffectiveTaxRate?: readonly {
    readonly RateValue?: number
    readonly EffectiveDate?: string
    readonly EndDate?: string
  }[]
}

export interface QuickBooksTaxAgency extends QuickBooksEntity {
  readonly DisplayName: string
  readonly TaxTrackedOnPurchases?: boolean
  readonly TaxTrackedOnSales?: boolean
  readonly TaxAgencyConfig?: string
  readonly TaxRegistrationNumber?: string
  readonly LastFileDate?: string
}

/** Global product/service tax categories. Classification IDs are not numeric. */
export interface QuickBooksTaxClassification extends QuickBooksEntity {
  readonly Code?: string
  readonly Name?: string
  readonly Description?: string
  readonly Level?: string
  readonly ParentRef?: QuickBooksReference
  readonly ApplicableTo?: readonly string[]
}

/** Sales-tax payment or refund. QuickBooks rejects this entity in US companies (5030). */
export interface QuickBooksTaxPayment extends QuickBooksEntity {
  readonly PaymentDate?: string
  readonly PaymentAccountRef?: QuickBooksReference
  readonly PaymentAmount?: number
  readonly Refund?: boolean
  readonly Description?: string
}
