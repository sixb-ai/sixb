import type { FullEnrichHttp } from "./http"
import { accountResource } from "./resources/account"
import { companiesResource } from "./resources/companies"
import { enrichmentsResource } from "./resources/enrichments"
import { peopleResource } from "./resources/people"
import { reverseEmailLookupsResource } from "./resources/reverse-email-lookups"
import type { FullEnrichClient } from "./types"

export function createFullEnrichClient(http: FullEnrichHttp): FullEnrichClient {
  return {
    enrichments: enrichmentsResource(http),
    reverseEmailLookups: reverseEmailLookupsResource(http),
    people: peopleResource(http),
    companies: companiesResource(http),
    account: accountResource(http),
  }
}
