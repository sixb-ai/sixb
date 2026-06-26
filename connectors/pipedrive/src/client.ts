import type { PipedriveHttp } from "./http"
import { activitiesResource } from "./resources/activities"
import { activityFieldsResource } from "./resources/activity-fields"
import { dealFieldsResource } from "./resources/deal-fields"
import { dealsResource } from "./resources/deals"
import { filesResource } from "./resources/files"
import { itemSearchResource } from "./resources/item-search"
import { leadsResource } from "./resources/leads"
import { notesResource } from "./resources/notes"
import { organizationFieldsResource } from "./resources/organization-fields"
import { organizationsResource } from "./resources/organizations"
import { personFieldsResource } from "./resources/person-fields"
import { personsResource } from "./resources/persons"
import { pipelinesResource } from "./resources/pipelines"
import { productFieldsResource } from "./resources/product-fields"
import { productsResource } from "./resources/products"
import { stagesResource } from "./resources/stages"
import { usersResource } from "./resources/users"
import type { PipedriveClient } from "./types"

export function createPipedriveClient(http: PipedriveHttp): PipedriveClient {
  return {
    activities: activitiesResource(http),
    activityFields: activityFieldsResource(http),
    deals: dealsResource(http),
    dealFields: dealFieldsResource(http),
    leads: leadsResource(http),
    organizations: organizationsResource(http),
    organizationFields: organizationFieldsResource(http),
    persons: personsResource(http),
    personFields: personFieldsResource(http),
    products: productsResource(http),
    productFields: productFieldsResource(http),
    pipelines: pipelinesResource(http),
    stages: stagesResource(http),
    notes: notesResource(http),
    files: filesResource(http),
    users: usersResource(http),
    itemSearch: itemSearchResource(http),
  }
}
