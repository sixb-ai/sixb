import type { ChangesResource } from "../resources/changes"
import type { CustomersResource } from "../resources/customers"
import type { LedgerAccountsResource } from "../resources/ledger-accounts"
import type { ProductsResource } from "../resources/products"
import type { QuotesResource } from "../resources/quotes"

export interface PennylaneClient {
  readonly quotes: QuotesResource
  readonly quoteChanges: ChangesResource
  readonly products: ProductsResource
  readonly productChanges: ChangesResource
  readonly customers: CustomersResource
  readonly customerChanges: ChangesResource
  readonly ledgerAccounts: LedgerAccountsResource
}
