import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type {
  Contact,
  ContactDeltaOptions,
  ContactDeltaPage,
  ContactFolder,
} from "../../types/contacts"
import { graphUrl, httpsUrl, query } from "../../validation"
import { mailboxPath } from "../mail/common"
import { contactsHeaders, folderPath } from "./common"

export interface ContactDeltaResource {
  /** Graph tracks one folder at a time; subfolders need their own cursor. */
  list(
    mailbox: string,
    folderId: string,
    options?: ContactDeltaOptions
  ): Promise<ContactDeltaPage<Contact>>
  pages(
    mailbox: string,
    folderId: string,
    options?: ContactDeltaOptions
  ): AsyncIterable<ContactDeltaPage<Contact>>
}
export interface ContactFolderDeltaResource {
  list(mailbox: string, options?: ContactDeltaOptions): Promise<ContactDeltaPage<ContactFolder>>
  pages(
    mailbox: string,
    options?: ContactDeltaOptions
  ): AsyncIterable<ContactDeltaPage<ContactFolder>>
}
function path(base: string, options?: ContactDeltaOptions): string {
  // Graph documents only $select (and the page size preference) for contact delta.
  for (const key of ["top", "filter", "orderBy", "expand", "search"])
    if (options && key in options)
      throw new MicrosoftConfigurationError(`Contact delta does not support ${key}.`)
  if (options?.cursor !== undefined) {
    if (options.select !== undefined)
      throw new MicrosoftConfigurationError(
        "A contact delta cursor cannot be combined with new query options."
      )
    return graphUrl(httpsUrl(options.cursor).href)
  }
  return `${base}${query(options)}`
}
async function list<T extends { id: string }>(
  http: MicrosoftHttp,
  base: string,
  options?: ContactDeltaOptions
): Promise<ContactDeltaPage<T>> {
  const value = await http.json(path(base, options), {
    signal: options?.signal,
    headers: contactsHeaders(options),
  })
  page(value)
  if (!isRecord(value)) throw new MicrosoftProtocolError("Invalid contact delta response.")
  const next = value["@odata.nextLink"]
  const delta = value["@odata.deltaLink"]
  if (
    (next !== undefined) === (delta !== undefined) ||
    (delta !== undefined && (typeof delta !== "string" || !delta))
  )
    throw new MicrosoftProtocolError("Contact delta must return exactly one nextLink or deltaLink.")
  graphUrl(httpsUrl(String(next ?? delta)).href)
  return value as unknown as ContactDeltaPage<T>
}
async function* pages<T extends { id: string }>(
  http: MicrosoftHttp,
  base: string,
  options?: ContactDeltaOptions
): AsyncIterable<ContactDeltaPage<T>> {
  let current = options
  const visited = new Set<string>()
  for (;;) {
    const url = graphUrl(path(base, current))
    if (visited.has(url)) throw new MicrosoftProtocolError("Contact delta repeated a nextLink.")
    visited.add(url)
    const result = await list<T>(http, base, current)
    yield result
    const cursor = result["@odata.nextLink"]
    if (!cursor) return
    current = { cursor, signal: options?.signal, pageSize: options?.pageSize }
  }
}
export function contactDeltaResource(http: MicrosoftHttp): ContactDeltaResource {
  return {
    list: async (mailbox, folderId, options) =>
      list(http, `${folderPath(mailbox, folderId)}/contacts/delta`, options),
    pages: (mailbox, folderId, options) =>
      pages(http, `${folderPath(mailbox, folderId)}/contacts/delta`, options),
  }
}
export function contactFolderDeltaResource(http: MicrosoftHttp): ContactFolderDeltaResource {
  return {
    list: async (mailbox, options) =>
      list(http, `${mailboxPath(mailbox)}/contactFolders/delta`, options),
    pages: (mailbox, options) =>
      pages(http, `${mailboxPath(mailbox)}/contactFolders/delta`, options),
  }
}
