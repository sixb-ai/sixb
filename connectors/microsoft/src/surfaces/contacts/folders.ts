import { MicrosoftConfigurationError } from "../../errors"
import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { allPages, page } from "../../pagination"
import type { GraphPage, RequestOptions, SelectOptions } from "../../types/common"
import type {
  Contact,
  ContactFolder,
  ContactFolderCreateOptions,
  ContactFolderListOptions,
  ContactFolderUpdate,
  MultiValueExtendedProperty,
  SingleValueExtendedProperty,
} from "../../types/contacts"
import { nonEmpty, query, resource } from "../../validation"
import { mailboxPath } from "../mail/common"
import { contactsHeaders, contactsPath, contactsQuery, folderPath, mutation } from "./common"
import { type ContactFolderDeltaResource, contactFolderDeltaResource } from "./delta"

export interface ContactFoldersResource {
  readonly delta: ContactFolderDeltaResource
  /** Folders created under the default Contacts folder; use listChildren for deeper levels. */
  list(mailbox: string, options?: ContactFolderListOptions): Promise<GraphPage<ContactFolder>>
  listAll(mailbox: string, options?: ContactFolderListOptions): AsyncIterable<ContactFolder>
  get(mailbox: string, id: string, options?: SelectOptions): Promise<ContactFolder>
  /**
   * The default Contacts folder, found through a contact it holds. Returns `null` while that
   * folder is empty: Graph v1.0 documents no other way to address it.
   */
  getDefault(mailbox: string, options?: SelectOptions): Promise<ContactFolder | null>
  listChildren(
    mailbox: string,
    id: string,
    options?: ContactFolderListOptions
  ): Promise<GraphPage<ContactFolder>>
  listAllChildren(
    mailbox: string,
    id: string,
    options?: ContactFolderListOptions
  ): AsyncIterable<ContactFolder>
  /** Creates under the default Contacts folder, or under `parentId`. */
  create(
    mailbox: string,
    displayName: string,
    options?: ContactFolderCreateOptions
  ): Promise<ContactFolder>
  update(
    mailbox: string,
    id: string,
    input: ContactFolderUpdate,
    options?: RequestOptions
  ): Promise<ContactFolder>
  /** The default Contacts folder cannot be deleted. */
  delete(mailbox: string, id: string, options?: RequestOptions): Promise<void>
  /** Removes the folder and its contacts from the mailbox without a recovery copy. */
  permanentDelete(mailbox: string, id: string, options?: RequestOptions): Promise<void>
}
function extendedProperties(input: {
  readonly singleValueExtendedProperties?: readonly SingleValueExtendedProperty[]
  readonly multiValueExtendedProperties?: readonly MultiValueExtendedProperty[]
}) {
  for (const property of [
    ...(input.singleValueExtendedProperties ?? []),
    ...(input.multiValueExtendedProperties ?? []),
  ])
    nonEmpty(property.id, "extended property id")
  return {
    ...(input.singleValueExtendedProperties
      ? { singleValueExtendedProperties: input.singleValueExtendedProperties }
      : {}),
    ...(input.multiValueExtendedProperties
      ? { multiValueExtendedProperties: input.multiValueExtendedProperties }
      : {}),
  }
}
export function contactFoldersResource(http: MicrosoftHttp): ContactFoldersResource {
  const list = async (path: string, options?: ContactFolderListOptions) =>
    page<ContactFolder>(
      await http.json(`${path}${contactsQuery(options)}`, {
        headers: contactsHeaders(),
        signal: options?.signal,
      })
    )
  const get = async (mailbox: string, id: string, options?: SelectOptions) =>
    resource<ContactFolder>(
      await http.json(`${folderPath(mailbox, id)}${query(options)}`, {
        headers: contactsHeaders(),
        signal: options?.signal,
      })
    )
  const write = async (path: string, method: string, body: unknown, options?: RequestOptions) =>
    resource<ContactFolder>(
      await readJson(
        await mutation(http, path, {
          method,
          body,
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    )
  return {
    delta: contactFolderDeltaResource(http),
    list: async (mailbox, options) => list(`${mailboxPath(mailbox)}/contactFolders`, options),
    listAll: (mailbox, options) =>
      allPages(
        http,
        `${mailboxPath(mailbox)}/contactFolders${contactsQuery(options)}`,
        options,
        contactsHeaders()
      ),
    get,
    async getDefault(mailbox, options) {
      const contacts = page<Contact>(
        await http.json(
          `${contactsPath(mailbox)}${query({ select: ["parentFolderId"], top: 1 })}`,
          { headers: contactsHeaders(), signal: options?.signal }
        )
      )
      const parent = contacts.value[0]?.parentFolderId
      return parent ? get(mailbox, parent, options) : null
    },
    listChildren: async (mailbox, id, options) =>
      list(`${folderPath(mailbox, id)}/childFolders`, options),
    listAllChildren: (mailbox, id, options) =>
      allPages(
        http,
        `${folderPath(mailbox, id)}/childFolders${contactsQuery(options)}`,
        options,
        contactsHeaders()
      ),
    async create(mailbox, displayName, options) {
      const path =
        options?.parentId === undefined
          ? `${mailboxPath(mailbox)}/contactFolders`
          : `${folderPath(mailbox, options.parentId)}/childFolders`
      const body = {
        displayName: nonEmpty(displayName, "displayName"),
        ...extendedProperties(options ?? {}),
      }
      return write(path, "POST", body, options)
    },
    async update(mailbox, id, input, options) {
      if (
        input.displayName === undefined &&
        input.parentFolderId === undefined &&
        input.singleValueExtendedProperties === undefined &&
        input.multiValueExtendedProperties === undefined
      )
        throw new MicrosoftConfigurationError(
          "A contact folder update requires at least one field."
        )
      if (input.displayName !== undefined) nonEmpty(input.displayName, "displayName")
      if (input.parentFolderId !== undefined) nonEmpty(input.parentFolderId, "parentFolderId")
      extendedProperties(input)
      return write(folderPath(mailbox, id), "PATCH", input, options)
    },
    async delete(mailbox, id, options) {
      await checkEmpty(
        await mutation(http, folderPath(mailbox, id), {
          method: "DELETE",
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
    async permanentDelete(mailbox, id, options) {
      await checkEmpty(
        await mutation(http, `${folderPath(mailbox, id)}/permanentDelete`, {
          method: "POST",
          headers: contactsHeaders(),
          signal: options?.signal,
        })
      )
    },
  }
}
