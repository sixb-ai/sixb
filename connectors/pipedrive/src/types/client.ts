import type { ActivitiesResource } from "../resources/activities"
import type { DealsResource } from "../resources/deals"
import type { FieldsResource } from "../resources/fields"
import type { FilesResource } from "../resources/files"
import type { ItemSearchResource } from "../resources/item-search"
import type { LeadsResource } from "../resources/leads"
import type { NotesResource } from "../resources/notes"
import type { OrganizationsResource } from "../resources/organizations"
import type { PersonsResource } from "../resources/persons"
import type { PipelinesResource } from "../resources/pipelines"
import type { ProductsResource } from "../resources/products"
import type { StagesResource } from "../resources/stages"
import type { UsersResource } from "../resources/users"
import type { PipedriveConnectorOptions } from "./common"
import type {
  PipedriveActivityField,
  PipedriveDealField,
  PipedriveOrganizationField,
  PipedrivePersonField,
  PipedriveProductField,
} from "./fields"

export interface PipedriveClient {
  readonly activities: ActivitiesResource
  readonly activityFields: FieldsResource<PipedriveActivityField>
  readonly deals: DealsResource
  readonly dealFields: FieldsResource<PipedriveDealField>
  readonly leads: LeadsResource
  readonly organizations: OrganizationsResource
  readonly organizationFields: FieldsResource<PipedriveOrganizationField>
  readonly persons: PersonsResource
  readonly personFields: FieldsResource<PipedrivePersonField>
  readonly products: ProductsResource
  readonly productFields: FieldsResource<PipedriveProductField>
  readonly pipelines: PipelinesResource
  readonly stages: StagesResource
  readonly notes: NotesResource
  readonly files: FilesResource
  readonly users: UsersResource
  readonly itemSearch: ItemSearchResource
}

export type PipedriveClientOptions = PipedriveConnectorOptions
