import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { QuickBooksAccountsResource } from "./resources/accounts"
import type { QuickBooksAttachmentsResource } from "./resources/attachments"
import type { QuickBooksBillPaymentsResource } from "./resources/bill-payments"
import type { QuickBooksBillsResource } from "./resources/bills"
import type { QuickBooksCdcResource } from "./resources/cdc"
import type { QuickBooksCreditMemosResource } from "./resources/credit-memos"
import type { QuickBooksCustomersResource } from "./resources/customers"
import type { QuickBooksInvoicesResource } from "./resources/invoices"
import type { QuickBooksItemsResource } from "./resources/items"
import type { QuickBooksPaymentsResource } from "./resources/payments"
import type { QuickBooksPreferencesResource } from "./resources/preferences"
import type { QuickBooksReportsResource } from "./resources/reports"
import type { QuickBooksTermsResource } from "./resources/terms"
import type { QuickBooksVendorCreditsResource } from "./resources/vendor-credits"
import type { QuickBooksVendorsResource } from "./resources/vendors"
import type { QuickBooksCompanyInfoUpdate, QuickBooksWriteOptions } from "./types/writes"
import type { QuickBooksEventsWebhookOptions } from "./webhooks"

export interface QuickBooksConnectorOptions {
  readonly webhooks?: QuickBooksEventsWebhookOptions
  readonly clientId: string
  readonly clientSecret: string
  readonly environment: "sandbox" | "production"
  /** Accounting API minor version. Defaults to 75. */
  readonly minorVersion?: number
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
}

export interface QuickBooksAddress {
  readonly Id?: string
  readonly Line1?: string
  readonly Line2?: string
  readonly Line3?: string
  readonly Line4?: string
  readonly Line5?: string
  readonly City?: string
  readonly Country?: string
  readonly CountrySubDivisionCode?: string
  readonly PostalCode?: string
  readonly Lat?: string
  readonly Long?: string
}

export interface QuickBooksCompanyInfo {
  readonly Id: string
  readonly SyncToken?: string
  readonly CompanyName: string
  readonly LegalName?: string
  readonly CompanyAddr?: QuickBooksAddress
  readonly CustomerCommunicationAddr?: QuickBooksAddress
  readonly LegalAddr?: QuickBooksAddress
  readonly PrimaryPhone?: { readonly FreeFormNumber?: string }
  readonly Email?: { readonly Address?: string }
  readonly WebAddr?: { readonly URI?: string }
  readonly Country?: string
  readonly FiscalYearStartMonth?: string
  readonly CompanyStartDate?: string
  readonly SupportedLanguages?: string
  readonly NameValue?: readonly { readonly Name: string; readonly Value: string }[]
  readonly MetaData?: { readonly CreateTime?: string; readonly LastUpdatedTime?: string }
  readonly domain?: string
  readonly sparse?: boolean
}

export interface QuickBooksClient {
  readonly attachments: QuickBooksAttachmentsResource
  readonly reports: QuickBooksReportsResource
  readonly cdc: QuickBooksCdcResource
  readonly invoices: QuickBooksInvoicesResource
  readonly payments: QuickBooksPaymentsResource
  readonly creditMemos: QuickBooksCreditMemosResource
  readonly bills: QuickBooksBillsResource
  readonly billPayments: QuickBooksBillPaymentsResource
  readonly vendorCredits: QuickBooksVendorCreditsResource
  readonly customers: QuickBooksCustomersResource
  readonly vendors: QuickBooksVendorsResource
  readonly accounts: QuickBooksAccountsResource
  readonly items: QuickBooksItemsResource
  readonly terms: QuickBooksTermsResource
  readonly preferences: QuickBooksPreferencesResource
  readonly companyInfo: {
    /** Sparse update using CompanyInfo.Id, which is distinct from the realm ID. */
    update(
      input: QuickBooksCompanyInfoUpdate,
      options?: QuickBooksWriteOptions
    ): Promise<QuickBooksCompanyInfo>
    /** GET /v3/company/{realmId}/companyinfo/{realmId} */
    get(): Promise<QuickBooksCompanyInfo>
  }
}

export interface QuickBooksFaultError {
  readonly code?: string
  readonly Message?: string
  readonly Detail?: string
  readonly element?: string
}
