import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { allPages, page } from "../../pagination"
import type { GraphPage } from "../../types/common"
import type {
  Contact,
  ContactFolderOptions,
  ContactGetOptions,
  ContactInput,
  ContactListOptions,
  ContactUpdate,
} from "../../types/contacts"
import { resource } from "../../validation"
import {
  contactPath,
  contactsHeaders,
  contactsPath,
  contactsQuery,
  mutation,
  validateContact,
} from "./common"
import { type ContactDeltaResource, contactDeltaResource } from "./delta"

export interface ContactItemsResource {
  readonly delta: ContactDeltaResource
  /** One folder: the default Contacts folder unless `folderId` is given. */
  list(mailbox: string, options?: ContactListOptions): Promise<GraphPage<Contact>>
  listAll(mailbox: string, options?: ContactListOptions): AsyncIterable<Contact>
  get(mailbox: string, id: string, options?: ContactGetOptions): Promise<Contact>
  create(mailbox: string, input: ContactInput, options?: ContactFolderOptions): Promise<Contact>
  update(
    mailbox: string,
    id: string,
    input: ContactUpdate,
    options?: ContactFolderOptions
  ): Promise<Contact>
  /** Graph DELETE, subject to Exchange retention; `permanentDelete` purges instead. */
  delete(mailbox: string, id: string, options?: ContactFolderOptions): Promise<void>
  /** Purges the contact; mail clients can no longer recover it. */
  permanentDelete(mailbox: string, id: string, options?: ContactFolderOptions): Promise<void>
}
export function contactItemsResource(http: MicrosoftHttp): ContactItemsResource {
  const write = async (path: string, method: string, body: unknown, signal?: AbortSignal) =>
    resource<Contact>(
      await readJson(
        await mutation(http, path, { method, body, headers: contactsHeaders(), signal })
      )
    )
  const empty = async (path: string, method: string, signal?: AbortSignal) =>
    checkEmpty(await mutation(http, path, { method, headers: contactsHeaders(), signal }))
  return {
    delta: contactDeltaResource(http),
    async list(mailbox, options) {
      return page(
        await http.json(`${contactsPath(mailbox, options?.folderId)}${contactsQuery(options)}`, {
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
    listAll(mailbox, options) {
      return allPages(
        http,
        `${contactsPath(mailbox, options?.folderId)}${contactsQuery(options)}`,
        options,
        contactsHeaders()
      )
    },
    async get(mailbox, id, options) {
      return resource(
        await http.json(`${contactPath(mailbox, id, options?.folderId)}${contactsQuery(options)}`, {
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
    async create(mailbox, input, options) {
      validateContact(input)
      const body = input.extensions
        ? {
            ...input,
            extensions: input.extensions.map((extension) => ({
              "@odata.type": "microsoft.graph.openTypeExtension",
              ...extension,
            })),
          }
        : input
      return write(contactsPath(mailbox, options?.folderId), "POST", body, options?.signal)
    },
    async update(mailbox, id, input, options) {
      validateContact(input)
      return write(contactPath(mailbox, id, options?.folderId), "PATCH", input, options?.signal)
    },
    async delete(mailbox, id, options) {
      return empty(contactPath(mailbox, id, options?.folderId), "DELETE", options?.signal)
    },
    async permanentDelete(mailbox, id, options) {
      return empty(
        `${contactPath(mailbox, id, options?.folderId)}/permanentDelete`,
        "POST",
        options?.signal
      )
    },
  }
}
