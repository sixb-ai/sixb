import { checkEmpty, type MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type { GraphPage, RequestOptions, SelectOptions } from "../../types/common"
import type { MailFolder, MailFolderListOptions } from "../../types/mail"
import { nonEmpty, resource } from "../../validation"
import { folderPath, mailboxPath, mailHeaders, mailPages, mailQuery } from "./common"
import { folderDeltaResource, type MailFolderDeltaResource } from "./delta"

export interface MailFoldersResource {
  readonly delta: MailFolderDeltaResource
  /** Top-level folders only; use listChildren to traverse the hierarchy. */
  list(mailbox: string, options?: MailFolderListOptions): Promise<GraphPage<MailFolder>>
  listAll(mailbox: string, options?: MailFolderListOptions): AsyncIterable<MailFolder>
  get(mailbox: string, id: string, options?: SelectOptions): Promise<MailFolder>
  listChildren(
    mailbox: string,
    id: string,
    options?: MailFolderListOptions
  ): Promise<GraphPage<MailFolder>>
  listAllChildren(
    mailbox: string,
    id: string,
    options?: MailFolderListOptions
  ): AsyncIterable<MailFolder>
  create(
    mailbox: string,
    displayName: string,
    options?: RequestOptions & { readonly parentId?: string; readonly isHidden?: boolean }
  ): Promise<MailFolder>
  rename(
    mailbox: string,
    id: string,
    displayName: string,
    options?: RequestOptions
  ): Promise<MailFolder>
  delete(mailbox: string, id: string, options?: RequestOptions): Promise<void>
}
export function foldersResource(http: MicrosoftHttp): MailFoldersResource {
  const list = async (
    path: string,
    options?: MailFolderListOptions
  ): Promise<GraphPage<MailFolder>> =>
    page(
      await http.json(`${path}${mailQuery(options)}`, {
        signal: options?.signal,
        headers: mailHeaders(),
      })
    )
  return {
    delta: folderDeltaResource(http),
    list(mailbox, options) {
      return list(`${mailboxPath(mailbox)}/mailFolders`, options)
    },
    listAll(mailbox, options) {
      return mailPages(http, `${mailboxPath(mailbox)}/mailFolders${mailQuery(options)}`, options)
    },
    async get(mailbox, id, options) {
      return resource(
        await http.json(`${folderPath(mailbox, id)}${mailQuery(options)}`, {
          signal: options?.signal,
          headers: mailHeaders(),
        })
      )
    },
    listChildren(mailbox, id, options) {
      return list(`${folderPath(mailbox, id)}/childFolders`, options)
    },
    listAllChildren(mailbox, id, options) {
      return mailPages(
        http,
        `${folderPath(mailbox, id)}/childFolders${mailQuery(options)}`,
        options
      )
    },
    async create(mailbox, displayName, options) {
      const path =
        options?.parentId === undefined
          ? `${mailboxPath(mailbox)}/mailFolders`
          : `${folderPath(mailbox, options.parentId)}/childFolders`
      return resource(
        await http.json(path, {
          method: "POST",
          body: {
            displayName: nonEmpty(displayName, "displayName"),
            ...(options?.isHidden !== undefined ? { isHidden: options.isHidden } : {}),
          },
          headers: mailHeaders(),
          signal: options?.signal,
        })
      )
    },
    async rename(mailbox, id, displayName, options) {
      return resource(
        await http.json(folderPath(mailbox, id), {
          method: "PATCH",
          body: { displayName: nonEmpty(displayName, "displayName") },
          headers: mailHeaders(),
          signal: options?.signal,
        })
      )
    },
    async delete(mailbox, id, options) {
      await checkEmpty(
        await http.request(folderPath(mailbox, id), {
          method: "DELETE",
          headers: mailHeaders(),
          signal: options?.signal,
        })
      )
    },
  }
}
