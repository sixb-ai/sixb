import type { CtmHttp } from "../http"
import { toPage } from "../pagination"
import type {
  CtmContactList,
  CtmId,
  CtmLookupObjectType,
  CtmLookupOptions,
  CtmLookupResult,
  CtmPage,
  CtmPageOptions,
  CtmRecord,
} from "../types"
import { assertNonEmpty, pathId } from "../validation"
import {
  type CtmAccountPath,
  type CtmListMethods,
  type CtmReadMethods,
  listMethods,
  readMethods,
} from "./shared"

/** `GET /lists` and `/lists/{id}` — contact lists, such as a dialer's or a routing allow-list. */
export interface ContactListsResource extends CtmReadMethods<CtmContactList> {
  /** `GET /lists/{id}/contacts` */
  listContacts(contactListId: CtmId, options?: CtmPageOptions): Promise<CtmPage<CtmRecord>>
  listAllContacts(contactListId: CtmId, options?: CtmPageOptions): AsyncIterable<CtmRecord>
  /** `GET /lists/{id}/contains` — whether the E.164 `phoneNumber` is on the list. */
  contains(contactListId: CtmId, phoneNumber: string): Promise<boolean>
}

export function contactListsResource(http: CtmHttp, at: CtmAccountPath): ContactListsResource {
  const list = (contactListId: CtmId) => at(`lists/${pathId(contactListId, "contactListId")}`)

  const contacts = (contactListId: CtmId) =>
    listMethods<CtmRecord>(http, () => `${list(contactListId)}/contacts`, "contacts")

  return {
    ...readMethods<CtmContactList>(http, at, "lists", "contact_lists", "contactListId"),

    listContacts(contactListId, options) {
      return contacts(contactListId).list(options)
    },

    listAllContacts(contactListId, options) {
      return contacts(contactListId).listAll(options)
    },

    async contains(contactListId, phoneNumber) {
      assertNonEmpty(phoneNumber, "phoneNumber")

      return http.exists(`${list(contactListId)}/contains`, { phone_number: phoneNumber })
    },
  }
}

/** `GET /custom_fields` and `/custom_fields/{id}` — the fields a call's `custom_fields` holds. */
export interface CustomFieldsResource extends CtmReadMethods<CtmRecord> {
  /** `GET /custom_fields/panels` — the panels that group fields in CTM's UI. */
  listPanels(): Promise<CtmPage<CtmRecord>>
  /** `GET /custom_fields/{id}/panel` */
  getPanel(panelId: CtmId): Promise<CtmRecord>
}

export function customFieldsResource(http: CtmHttp, at: CtmAccountPath): CustomFieldsResource {
  return {
    ...readMethods<CtmRecord>(http, at, "custom_fields", "custom_fields", "customFieldId"),

    async listPanels() {
      return toPage<CtmRecord>(await http.get(at("custom_fields/panels")), "panels", 1)
    },

    async getPanel(panelId) {
      return http.get<CtmRecord>(at(`custom_fields/${pathId(panelId, "panelId")}/panel`))
    },
  }
}

/** `GET /form_reactors` and `/form_reactors/{id}` — the web forms whose submissions CTM logs. */
export type FormReactorsResource = CtmReadMethods<CtmRecord>

export function formReactorsResource(http: CtmHttp, at: CtmAccountPath): FormReactorsResource {
  return readMethods(http, at, "form_reactors", "form_reactors", "formReactorId")
}

/**
 * `GET /lookup` — find objects of one type by text. It is the only way to list the account's
 * tags: `lookup.list("tag")`.
 */
export interface LookupResource {
  list(
    objectType: CtmLookupObjectType,
    options?: CtmLookupOptions
  ): Promise<CtmPage<CtmLookupResult>>
  listAll(
    objectType: CtmLookupObjectType,
    options?: CtmLookupOptions
  ): AsyncIterable<CtmLookupResult>
}

export function lookupResource(http: CtmHttp, at: CtmAccountPath): LookupResource {
  const lookup = (
    objectType: CtmLookupObjectType
  ): CtmListMethods<CtmLookupResult, CtmLookupOptions> =>
    listMethods<CtmLookupResult, CtmLookupOptions>(
      http,
      () => {
        // Checked as the request is built, so `listAll` reports it on its first read like every
        // other argument.
        assertNonEmpty(objectType, "objectType")

        return at("lookup.json")
      },
      "results",
      (options) => ({ object_type: objectType, search: options?.search })
    )

  return {
    list(objectType, options) {
      return lookup(objectType).list(options)
    },

    listAll(objectType, options) {
      return lookup(objectType).listAll(options)
    },
  }
}
