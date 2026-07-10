import type { PennylaneHttp } from "./http"
import { createQuoteChangesResource } from "./resources/quote-changes"
import { createQuotesResource } from "./resources/quotes"
import type { PennylaneClient } from "./types"

export function createPennylaneClient(http: PennylaneHttp): PennylaneClient {
  return {
    quotes: createQuotesResource(http),
    quoteChanges: createQuoteChangesResource(http),
  }
}
