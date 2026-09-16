import { MicrosoftConfigurationError, MicrosoftProtocolError } from "../../errors"
import { isRecord } from "../../guards"
import type { MicrosoftHttp } from "../../http"
import { page } from "../../pagination"
import type {
  MailDeltaOptions,
  MailDeltaPage,
  MailFolder,
  MailMessage,
  MailMessageDeltaOptions,
} from "../../types/mail"
import { graphUrl, httpsUrl, query } from "../../validation"
import { folderPath, mailboxPath, mailHeaders } from "./common"

export interface MailMessageDeltaResource {
  list(
    mailbox: string,
    folderId: string,
    options?: MailMessageDeltaOptions
  ): Promise<MailDeltaPage<MailMessage>>
  pages(
    mailbox: string,
    folderId: string,
    options?: MailMessageDeltaOptions
  ): AsyncIterable<MailDeltaPage<MailMessage>>
}
export interface MailFolderDeltaResource {
  list(mailbox: string, options?: MailDeltaOptions): Promise<MailDeltaPage<MailFolder>>
  pages(mailbox: string, options?: MailDeltaOptions): AsyncIterable<MailDeltaPage<MailFolder>>
}
function path(base: string, options?: MailMessageDeltaOptions): string {
  if (options?.cursor !== undefined) {
    if (
      [
        options.select,
        options.expand,
        options.top,
        options.filter,
        options.orderBy,
        options.changeType,
      ].some((value) => value !== undefined)
    )
      throw new MicrosoftConfigurationError(
        "A mail delta cursor cannot be combined with new query options."
      )
    return graphUrl(httpsUrl(options.cursor).href)
  }
  const params = new URLSearchParams(query(options).slice(1))
  if (options?.changeType !== undefined) {
    if (!["created", "updated", "deleted"].includes(options.changeType))
      throw new MicrosoftConfigurationError("Invalid mail delta changeType.")
    params.set("changeType", options.changeType)
  }
  if (options?.filter !== undefined) {
    if (
      !/^receivedDateTime (ge|gt) \d{4}-\d{2}-\d{2}T\S+$/.test(options.filter) ||
      !Number.isFinite(Date.parse(options.filter.split(" ")[2]))
    )
      throw new MicrosoftConfigurationError(
        "Mail delta filter must be receivedDateTime ge/gt followed by an ISO timestamp."
      )
    params.set("$filter", options.filter)
  }
  if (options?.orderBy !== undefined && options.orderBy !== "receivedDateTime desc")
    throw new MicrosoftConfigurationError("Mail delta orderBy must be receivedDateTime desc.")
  return `${base}${params.size ? `?${params}` : ""}`
}
async function list<T extends { id: string }>(
  http: MicrosoftHttp,
  base: string,
  options?: MailMessageDeltaOptions
): Promise<MailDeltaPage<T>> {
  const value = await http.json(path(base, options), {
    signal: options?.signal,
    headers: mailHeaders(options),
  })
  page(value)
  if (!isRecord(value)) throw new MicrosoftProtocolError("Invalid mail delta response.")
  const next = value["@odata.nextLink"]
  const delta = value["@odata.deltaLink"]
  if (
    (next !== undefined) === (delta !== undefined) ||
    (delta !== undefined && (typeof delta !== "string" || !delta))
  )
    throw new MicrosoftProtocolError("Mail delta must return exactly one nextLink or deltaLink.")
  graphUrl(httpsUrl(String(next ?? delta)).href)
  return value as unknown as MailDeltaPage<T>
}
async function* pages<T extends { id: string }>(
  http: MicrosoftHttp,
  base: string,
  options?: MailMessageDeltaOptions
): AsyncIterable<MailDeltaPage<T>> {
  let current = options
  const visited = new Set<string>()
  for (;;) {
    const url = graphUrl(path(base, current))
    if (visited.has(url)) throw new MicrosoftProtocolError("Mail delta repeated a nextLink.")
    visited.add(url)
    const result = await list<T>(http, base, current)
    yield result
    const cursor = result["@odata.nextLink"]
    if (!cursor) return
    current = {
      cursor,
      signal: options?.signal,
      pageSize: options?.pageSize,
      bodyContentType: options?.bodyContentType,
    }
  }
}
export function messageDeltaResource(http: MicrosoftHttp): MailMessageDeltaResource {
  return {
    list: (mailbox, folderId, options) =>
      list(http, `${folderPath(mailbox, folderId)}/messages/delta`, options),
    pages: (mailbox, folderId, options) =>
      pages(http, `${folderPath(mailbox, folderId)}/messages/delta`, options),
  }
}
export function folderDeltaResource(http: MicrosoftHttp): MailFolderDeltaResource {
  return {
    list: (mailbox, options) => list(http, `${mailboxPath(mailbox)}/mailFolders/delta`, options),
    pages: (mailbox, options) => pages(http, `${mailboxPath(mailbox)}/mailFolders/delta`, options),
  }
}
