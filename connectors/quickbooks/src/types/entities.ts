import type { QuickBooksAddress } from "../types"

export interface QuickBooksReference {
  readonly value: string
  readonly name?: string
  readonly type?: string
}

export interface QuickBooksEntity {
  readonly Id: string
  readonly SyncToken?: string
  readonly MetaData?: { readonly CreateTime?: string; readonly LastUpdatedTime?: string }
  readonly domain?: string
  readonly sparse?: boolean
}

export interface QuickBooksCustomField {
  readonly DefinitionId?: string
  readonly Name?: string
  readonly Type?: string
  readonly StringValue?: string
  readonly BooleanValue?: boolean
  readonly NumberValue?: number
  readonly DateValue?: string
}

interface QuickBooksContact extends QuickBooksEntity {
  readonly DisplayName: string
  readonly Active?: boolean
  readonly Title?: string
  readonly GivenName?: string
  readonly MiddleName?: string
  readonly FamilyName?: string
  readonly Suffix?: string
  readonly CompanyName?: string
  readonly PrintOnCheckName?: string
  readonly PrimaryPhone?: { readonly FreeFormNumber?: string }
  readonly AlternatePhone?: { readonly FreeFormNumber?: string }
  readonly Mobile?: { readonly FreeFormNumber?: string }
  readonly Fax?: { readonly FreeFormNumber?: string }
  readonly PrimaryEmailAddr?: { readonly Address?: string }
  readonly WebAddr?: { readonly URI?: string }
  readonly BillAddr?: QuickBooksAddress
  readonly Balance?: number
  readonly CurrencyRef?: QuickBooksReference
  readonly TaxIdentifier?: string
  readonly GSTIN?: string
  readonly BusinessNumber?: string
  readonly Source?: string
}

export interface QuickBooksCustomer extends QuickBooksContact {
  readonly FullyQualifiedName?: string
  readonly ShipAddr?: QuickBooksAddress
  readonly Notes?: string
  readonly Job?: boolean
  readonly BillWithParent?: boolean
  readonly ParentRef?: QuickBooksReference
  readonly Level?: number
  readonly BalanceWithJobs?: number
  readonly SalesTermRef?: QuickBooksReference
  readonly PaymentMethodRef?: QuickBooksReference
  readonly DefaultTaxCodeRef?: QuickBooksReference
  readonly Taxable?: boolean
  readonly TaxExemptionReasonId?: string
  readonly PreferredDeliveryMethod?: string
  readonly ResaleNum?: string
  readonly CustomerTypeRef?: QuickBooksReference
  readonly IsProject?: boolean
  readonly PrimaryTaxIdentifier?: string
  readonly SecondaryTaxIdentifier?: string
  readonly GSTRegistrationType?: string
  readonly ARAccountRef?: QuickBooksReference
  readonly CustomField?: readonly QuickBooksCustomField[]
}

export interface QuickBooksVendor extends QuickBooksContact {
  readonly AcctNum?: string
  readonly Vendor1099?: boolean
  readonly TermRef?: QuickBooksReference
  readonly APAccountRef?: QuickBooksReference
  readonly OtherContactInfo?: readonly {
    readonly Type?: string
    readonly Telephone?: { readonly FreeFormNumber?: string }
  }[]
  readonly BillRate?: number
  readonly CostRate?: number
  readonly GSTRegistrationType?: string
  readonly T4AEligible?: boolean
  readonly T5018Eligible?: boolean
}

export interface QuickBooksAccount extends QuickBooksEntity {
  readonly Name: string
  readonly Active?: boolean
  readonly FullyQualifiedName?: string
  readonly Description?: string
  readonly Classification?: string
  readonly AccountType?: string
  readonly AccountSubType?: string
  readonly AcctNum?: string
  readonly SubAccount?: boolean
  readonly ParentRef?: QuickBooksReference
  readonly CurrentBalance?: number
  readonly CurrentBalanceWithSubAccounts?: number
  readonly CurrencyRef?: QuickBooksReference
  readonly TaxCodeRef?: QuickBooksReference
  readonly OnlineBankingEnabled?: boolean
}

export interface QuickBooksItem extends QuickBooksEntity {
  readonly Name: string
  readonly Active?: boolean
  readonly Type?: "Inventory" | "NonInventory" | "Service" | "Category" | "Group" | (string & {})
  readonly FullyQualifiedName?: string
  readonly Description?: string
  readonly Sku?: string
  readonly SubItem?: boolean
  readonly ParentRef?: QuickBooksReference
  readonly Level?: number
  readonly Taxable?: boolean
  readonly UnitPrice?: number
  readonly PurchaseCost?: number
  readonly PurchaseDesc?: string
  readonly IncomeAccountRef?: QuickBooksReference
  readonly ExpenseAccountRef?: QuickBooksReference
  readonly AssetAccountRef?: QuickBooksReference
  readonly PrefVendorRef?: QuickBooksReference
  readonly TrackQtyOnHand?: boolean
  readonly QtyOnHand?: number
  readonly InvStartDate?: string
  readonly SalesTaxCodeRef?: QuickBooksReference
  readonly PurchaseTaxCodeRef?: QuickBooksReference
  readonly SalesTaxIncluded?: boolean
  readonly PurchaseTaxIncluded?: boolean
  readonly ItemGroupDetail?: {
    readonly ItemGroupLine?: readonly {
      readonly ItemRef?: QuickBooksReference
      readonly Qty?: number
    }[]
  }
}

export interface QuickBooksTerm extends QuickBooksEntity {
  readonly Name: string
  readonly Active?: boolean
  readonly Type?: string
  readonly DueDays?: number
  readonly DiscountPercent?: number
  readonly DiscountDays?: number
  readonly DayOfMonthDue?: number
  readonly DueNextMonthDays?: number
  readonly DiscountDayOfMonth?: number
}

/** Preference groups vary by company locale and enabled products. */
export interface QuickBooksPreferences extends QuickBooksEntity {
  readonly CurrencyPrefs?: {
    readonly MultiCurrencyEnabled?: boolean
    readonly HomeCurrency?: QuickBooksReference
  }
  readonly AccountingInfoPrefs?: {
    readonly FirstMonthOfFiscalYear?: string
    readonly UseAccountNumbers?: boolean
    readonly TaxYearMonth?: string
    readonly ClassTrackingPerTxn?: boolean
    readonly ClassTrackingPerTxnLine?: boolean
    readonly TrackDepartments?: boolean
    readonly DepartmentTerminology?: string
    readonly BookCloseDate?: string
  }
  readonly TaxPrefs?: {
    readonly UsingSalesTax?: boolean
    readonly TaxGroupCodeRef?: QuickBooksReference
    readonly PartnerTaxEnabled?: boolean
  }
  readonly SalesFormsPrefs?: {
    readonly UsingProgressInvoicing?: boolean
    readonly CustomTxnNumbers?: boolean
    readonly AllowDeposit?: boolean
    readonly AllowDiscount?: boolean
    readonly AllowShipping?: boolean
    readonly DefaultCustomerMessage?: string
    readonly DefaultTerms?: QuickBooksReference
    readonly DefaultDiscountAccount?: string
    readonly AutoApplyCredit?: boolean
    readonly AutoApplyPayments?: boolean
    readonly UsingPriceLevels?: boolean
    readonly ETransactionEnabledStatus?: string
    readonly ETransactionAttachPDF?: boolean
    readonly ETransactionPaymentEnabled?: boolean
    readonly CustomField?: readonly { readonly CustomField?: readonly QuickBooksCustomField[] }[]
  }
  readonly VendorAndPurchasesPrefs?: {
    readonly TrackingByCustomer?: boolean
    readonly BillableExpenseTracking?: boolean
    readonly POCustomField?: readonly { readonly CustomField?: readonly QuickBooksCustomField[] }[]
  }
  readonly ProductAndServicesPrefs?: {
    readonly ForSales?: boolean
    readonly ForPurchase?: boolean
    readonly QuantityWithPriceAndRate?: boolean
    readonly QuantityOnHand?: boolean
  }
  readonly ReportPrefs?: {
    readonly ReportBasis?: string
    readonly CalcAgingReportFromTxnDate?: boolean
  }
  readonly OtherPrefs?: {
    readonly NameValue?: readonly { readonly Name: string; readonly Value: string }[]
  }
  readonly TimeTrackingPrefs?: {
    readonly UseServices?: boolean
    readonly BillCustomers?: boolean
    readonly ShowBillRateToAll?: boolean
    readonly WorkWeekStartDate?: string
  }
}
