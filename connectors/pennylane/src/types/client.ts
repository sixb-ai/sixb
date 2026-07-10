import type { QuoteChangesResource } from "../resources/quote-changes"
import type { QuotesResource } from "../resources/quotes"

export interface PennylaneClient {
  readonly quotes: QuotesResource
  readonly quoteChanges: QuoteChangesResource
}
