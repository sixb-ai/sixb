import type { FleetioHttp } from "../http"
import type {
  FleetioArchivedContactFilter,
  FleetioArchivedContactSort,
  FleetioContact,
  FleetioContactCreateInput,
  FleetioContactFilter,
  FleetioContactSort,
  FleetioContactSummary,
  FleetioContactUpdateInput,
  FleetioId,
  FleetioListOptions,
  FleetioPage,
} from "../types"
import { pathId } from "../validation"
import {
  type FleetioListMethods,
  type FleetioSearchMethods,
  type FleetioWriteMethods,
  listMethods,
  searchMethods,
  writeMethods,
} from "./crud"

type ArchivedOptions = FleetioListOptions<FleetioArchivedContactFilter, FleetioArchivedContactSort>

export interface FleetioContactGetOptions {
  /** Additional attributes to return with the contact. Fleetio accepts `group`. */
  readonly expand?: readonly string[]
}

export type ContactsResource = FleetioListMethods<
  FleetioContactSummary,
  FleetioContactFilter,
  FleetioContactSort
> &
  FleetioWriteMethods<
    FleetioContactCreateInput,
    FleetioContact,
    FleetioContactUpdateInput,
    FleetioContact
  > &
  FleetioSearchMethods<FleetioContactSummary, FleetioContactFilter, FleetioContactSort> & {
    get(id: FleetioId, options?: FleetioContactGetOptions): Promise<FleetioContact>
    /** `PATCH /contacts/{id}/archive` */
    archive(id: FleetioId): Promise<void>
    /** `PATCH /contacts/{id}/restore` */
    restore(id: FleetioId): Promise<void>
    /** `GET /contacts/archived` */
    listArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioContactSummary>>
    listAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioContactSummary>
    /** `POST /contacts/archived/search` */
    searchArchived(options?: ArchivedOptions): Promise<FleetioPage<FleetioContactSummary>>
    searchAllArchived(options?: ArchivedOptions): AsyncIterable<FleetioContactSummary>
  }

export function contactsResource(http: FleetioHttp): ContactsResource {
  const contactPath = (id: FleetioId) => `contacts/${pathId(id, "contact id")}`
  const archived = listMethods<
    FleetioContactSummary,
    FleetioArchivedContactFilter,
    FleetioArchivedContactSort
  >(http, "contacts/archived")
  const archivedSearch = searchMethods<
    FleetioContactSummary,
    FleetioArchivedContactFilter,
    FleetioArchivedContactSort
  >(http, "contacts/archived/search")

  return {
    ...listMethods(http, "contacts"),
    ...writeMethods(http, "contacts", "contact id"),
    ...searchMethods(http, "contacts/search"),
    get(id, options) {
      return http.get(contactPath(id), { "expand[]": options?.expand })
    },
    archive: (id) => http.patch(`${contactPath(id)}/archive`),
    restore: (id) => http.patch(`${contactPath(id)}/restore`),
    listArchived: archived.list,
    listAllArchived: archived.listAll,
    searchArchived: archivedSearch.search,
    searchAllArchived: archivedSearch.searchAll,
  }
}
