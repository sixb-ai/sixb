import type { PennylaneHttp } from "./http"
import { createChangesResource } from "./resources/changes"
import { createCustomersResource } from "./resources/customers"
import { createProductsResource } from "./resources/products"
import { createQuotesResource } from "./resources/quotes"
import type { PennylaneClient } from "./types"

export function createPennylaneClient(http: PennylaneHttp): PennylaneClient {
  return {
    quotes: createQuotesResource(http),
    quoteChanges: createChangesResource(http, "changelogs/quotes", "quote changes"),
    products: createProductsResource(http),
    productChanges: createChangesResource(http, "changelogs/products", "product changes"),
    customers: createCustomersResource(http),
    customerChanges: createChangesResource(http, "changelogs/customers", "customer changes"),
  }
}
