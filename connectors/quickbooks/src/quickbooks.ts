import type { OAuthConnectorAdapter } from "@sixb/core"
import { createQuickBooksHttp } from "./http"
import { createQuickBooksOAuth } from "./oauth"
import { createAccountsResource } from "./resources/accounts"
import { createAttachmentsResource } from "./resources/attachments"
import { createBillPaymentsResource } from "./resources/bill-payments"
import { createBillsResource } from "./resources/bills"
import { createBudgetsResource } from "./resources/budgets"
import { createCdcResource } from "./resources/cdc"
import { createClassesResource } from "./resources/classes"
import { createCompanyCurrenciesResource } from "./resources/company-currencies"
import { createCreditMemosResource } from "./resources/credit-memos"
import { createCustomerTypesResource } from "./resources/customer-types"
import { createCustomersResource } from "./resources/customers"
import { createDepartmentsResource } from "./resources/departments"
import { createEmployeesResource } from "./resources/employees"
import { createEstimatesResource } from "./resources/estimates"
import { createExchangeRatesResource } from "./resources/exchange-rates"
import { createInvoicesResource } from "./resources/invoices"
import { createItemsResource } from "./resources/items"
import { createPaymentMethodsResource } from "./resources/payment-methods"
import { createPaymentsResource } from "./resources/payments"
import { createPreferencesResource } from "./resources/preferences"
import { createRefundReceiptsResource } from "./resources/refund-receipts"
import { createReportsResource } from "./resources/reports"
import { createSalesReceiptsResource } from "./resources/sales-receipts"
import { createTaxAgenciesResource } from "./resources/tax-agencies"
import { createTaxClassificationsResource } from "./resources/tax-classifications"
import { createTaxCodesResource } from "./resources/tax-codes"
import { createTaxRatesResource } from "./resources/tax-rates"
import { createTermsResource } from "./resources/terms"
import { createVendorCreditsResource } from "./resources/vendor-credits"
import { createVendorsResource } from "./resources/vendors"
import type { QuickBooksClient, QuickBooksCompanyInfo, QuickBooksConnectorOptions } from "./types"
import { isRecord, nonEmpty, realmId } from "./validation"
import { quickbooksEventsWebhook } from "./webhooks"
import { updateEntity } from "./write"

export type QuickBooksConnector = OAuthConnectorAdapter<"quickbooks", QuickBooksClient>

export function quickbooks(input: QuickBooksConnectorOptions): QuickBooksConnector {
  const options = { ...input, retry: input.retry ? { ...input.retry } : undefined }
  nonEmpty(options.clientId, "clientId")
  nonEmpty(options.clientSecret, "clientSecret")
  if (options.environment !== "sandbox" && options.environment !== "production")
    throw new Error("[SixbQuickBooks] environment must be sandbox or production.")
  for (const [name, value, minimum] of [
    ["minorVersion", options.minorVersion ?? 75, 75],
    ["timeoutMs", options.timeoutMs ?? 1, 1],
    ["minDelayMs", options.minDelayMs ?? 0, 0],
    ["retry.maxRetries", options.retry?.maxRetries ?? 2, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`[SixbQuickBooks] ${name} must be an integer >= ${minimum}.`)
  }
  return {
    type: "quickbooks",
    webhooks: options.webhooks ? [quickbooksEventsWebhook(options.webhooks)] : undefined,
    authentication: createQuickBooksOAuth(options),
    async discoverAccounts(context, credentials) {
      const id = realmId(credentials.authorizationContext?.realmId)
      const http = await createQuickBooksHttp(
        context,
        {
          async get() {
            return { accessToken: credentials.accessToken, invalidate() {} }
          },
        },
        options,
        id,
        false
      )
      const company = await readCompany(http, id)
      return [{ id, label: company.CompanyName, description: company.LegalName }]
    },
    async connect(context) {
      context.signal.throwIfAborted()
      const id = realmId(context.account.id)
      const http = await createQuickBooksHttp(context, context.tokenSource, options, id, true)
      return {
        companyInfo: {
          get: () => readCompany(http, id),
          async update(input, options) {
            if (input.CompanyName !== undefined) nonEmpty(input.CompanyName, "CompanyName")
            return updateEntity(http, "CompanyInfo", input, options)
          },
        },
        cdc: createCdcResource(http),
        attachments: createAttachmentsResource(http),
        reports: createReportsResource(http),
        preferences: createPreferencesResource(http),
        customers: createCustomersResource(http),
        vendors: createVendorsResource(http),
        accounts: createAccountsResource(http),
        items: createItemsResource(http),
        terms: createTermsResource(http),
        estimates: createEstimatesResource(http),
        invoices: createInvoicesResource(http),
        payments: createPaymentsResource(http),
        creditMemos: createCreditMemosResource(http),
        bills: createBillsResource(http),
        billPayments: createBillPaymentsResource(http),
        vendorCredits: createVendorCreditsResource(http),
        refundReceipts: createRefundReceiptsResource(http),
        salesReceipts: createSalesReceiptsResource(http),
        paymentMethods: createPaymentMethodsResource(http),
        departments: createDepartmentsResource(http),
        classes: createClassesResource(http),
        employees: createEmployeesResource(http),
        exchangeRates: createExchangeRatesResource(http),
        companyCurrencies: createCompanyCurrenciesResource(http),
        budgets: createBudgetsResource(http),
        taxClassifications: createTaxClassificationsResource(http),
        taxAgencies: createTaxAgenciesResource(http),
        taxRates: createTaxRatesResource(http),
        taxCodes: createTaxCodesResource(http),
        customerTypes: createCustomerTypesResource(http),
      }
    },
  }
}

async function readCompany(
  http: Awaited<ReturnType<typeof createQuickBooksHttp>>,
  id: string
): Promise<QuickBooksCompanyInfo> {
  const body = await http.get(`companyinfo/${id}`)
  const company = isRecord(body) ? body.CompanyInfo : undefined
  // The authenticated URL selects the realm. CompanyInfo.Id is a separate entity ID
  // ("1" in the live sandbox), not the OAuth realmId.
  if (
    !isRecord(company) ||
    typeof company.Id !== "string" ||
    !company.Id.trim() ||
    typeof company.CompanyName !== "string" ||
    !company.CompanyName.trim()
  ) {
    throw new Error(
      "[SixbQuickBooks] CompanyInfo response does not identify the requested company."
    )
  }
  return company as unknown as QuickBooksCompanyInfo
}
