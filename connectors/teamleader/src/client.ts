import { assertAccessTokenResolver, createRequester } from "./http"
import { createCompaniesResource } from "./resources/companies"
import { createContactsResource } from "./resources/contacts"
import { createCustomFieldDefinitionsResource } from "./resources/custom-field-definitions"
import { createDealsResource } from "./resources/deals"
import { createQuotationsResource } from "./resources/quotations"
import { createWebhooksResource } from "./resources/webhooks"
import type { TeamleaderClient, TeamleaderClientOptions } from "./types"

export function createTeamleaderClient(options: TeamleaderClientOptions): TeamleaderClient {
  assertAccessTokenResolver(options.accessToken)

  const request = createRequester(options)

  return {
    deals: createDealsResource(request),
    quotations: createQuotationsResource(request),
    contacts: createContactsResource(request),
    companies: createCompaniesResource(request),
    customFieldDefinitions: createCustomFieldDefinitionsResource(request),
    webhooks: createWebhooksResource(request),
  }
}
