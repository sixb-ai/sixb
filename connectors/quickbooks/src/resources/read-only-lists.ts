import { nameListReader, type QuickBooksReadHttp } from "../query"
import type {
  QuickBooksBudget,
  QuickBooksCompanyCurrency,
  QuickBooksCustomerType,
} from "../types/entities"
import type {
  QuickBooksBudgetListOptions,
  QuickBooksCompanyCurrencyListOptions,
  QuickBooksCustomerTypeListOptions,
  QuickBooksReadResource,
  QuickBooksTaxAgencyListOptions,
  QuickBooksTaxCodeListOptions,
  QuickBooksTaxRateListOptions,
} from "../types/query"
import type { QuickBooksTaxAgency, QuickBooksTaxCode, QuickBooksTaxRate } from "../types/tax"

export type QuickBooksCustomerTypesResource = QuickBooksReadResource<
  QuickBooksCustomerType,
  QuickBooksCustomerTypeListOptions
>
/** `list` always filters on Active, which excludes the US pseudo-codes TAX and NON. */
export type QuickBooksTaxCodesResource = QuickBooksReadResource<
  QuickBooksTaxCode,
  QuickBooksTaxCodeListOptions
>
export type QuickBooksTaxRatesResource = QuickBooksReadResource<
  QuickBooksTaxRate,
  QuickBooksTaxRateListOptions
>
/** TaxAgency has no Active flag; `name` matches the agency's display name. */
export type QuickBooksTaxAgenciesResource = QuickBooksReadResource<
  QuickBooksTaxAgency,
  QuickBooksTaxAgencyListOptions
>
export type QuickBooksBudgetsResource = QuickBooksReadResource<
  QuickBooksBudget,
  QuickBooksBudgetListOptions
>
/** Requires multicurrency; currencies have no name filter. */
export type QuickBooksCompanyCurrenciesResource = QuickBooksReadResource<
  QuickBooksCompanyCurrency,
  QuickBooksCompanyCurrencyListOptions
>

export function createCustomerTypesResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksCustomerType, QuickBooksCustomerTypeListOptions>(
    http,
    "CustomerType",
    "customertype",
    "Name"
  )
}

export function createTaxCodesResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksTaxCode, QuickBooksTaxCodeListOptions>(
    http,
    "TaxCode",
    "taxcode",
    "Name"
  )
}

export function createTaxRatesResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksTaxRate, QuickBooksTaxRateListOptions>(
    http,
    "TaxRate",
    "taxrate",
    "Name"
  )
}

export function createTaxAgenciesResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksTaxAgency, QuickBooksTaxAgencyListOptions>(
    http,
    "TaxAgency",
    "taxagency",
    "Name",
    { active: false }
  )
}

export function createBudgetsResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksBudget, QuickBooksBudgetListOptions>(
    http,
    "Budget",
    "budget",
    "Name"
  )
}

export function createCompanyCurrenciesResource(http: QuickBooksReadHttp) {
  return nameListReader<QuickBooksCompanyCurrency, QuickBooksCompanyCurrencyListOptions>(
    http,
    "CompanyCurrency",
    "companycurrency",
    undefined
  )
}
