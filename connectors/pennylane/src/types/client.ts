import type { CustomersResource } from "../resources/customers"
import type { ProductsResource } from "../resources/products"
import type { QuoteChangesResource } from "../resources/quote-changes"
import type { QuotesResource } from "../resources/quotes"

export interface PennylaneClient {
  readonly quotes: QuotesResource
  readonly quoteChanges: QuoteChangesResource
  readonly products: ProductsResource
  readonly customers: CustomersResource
}
