import { readResponseBody } from "@sixb/connector-rest"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../../errors"
import type { MicrosoftHttp } from "../../http"
import { readJson } from "../../http"
import { page } from "../../pagination"
import type { GraphPage, RequestOptions } from "../../types/common"
import type {
  MailFolderListOptions,
  MailGetOptions,
  MailListOptions,
  MailSendResult,
} from "../../types/mail"
import { graphUrl, nonEmpty, query, segment } from "../../validation"

export const mailboxPath = (mailbox: string) => `users/${segment(mailbox, "mailbox")}`
export const messagePath = (mailbox: string, id: string) =>
  `${mailboxPath(mailbox)}/messages/${segment(id, "messageId")}`
export const folderPath = (mailbox: string, id: string) =>
  `${mailboxPath(mailbox)}/mailFolders/${segment(id, "folderId")}`

export function mailHeaders(options?: {
  bodyContentType?: "text" | "html"
  pageSize?: number
}): HeadersInit {
  const preferences = ['IdType="ImmutableId"']
  if (options?.bodyContentType !== undefined) {
    if (!["text", "html"].includes(options.bodyContentType))
      throw new MicrosoftConfigurationError("bodyContentType must be text or html.")
    preferences.push(`outlook.body-content-type="${options.bodyContentType}"`)
  }
  if (options?.pageSize !== undefined) {
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize <= 0)
      throw new MicrosoftConfigurationError("pageSize must be a positive integer.")
    preferences.push(`odata.maxpagesize=${options.pageSize}`)
  }
  return { Prefer: preferences.join(", ") }
}
export function mailQuery(
  options?: MailGetOptions | MailListOptions | MailFolderListOptions
): string {
  const params = new URLSearchParams(query(options).slice(1))
  if (options && "filter" in options && options.filter !== undefined)
    params.set("$filter", nonEmpty(options.filter, "filter"))
  if (options && "search" in options && options.search !== undefined) {
    if (options.filter !== undefined || options.orderBy !== undefined)
      throw new MicrosoftConfigurationError("search cannot be combined with filter or orderBy.")
    params.set("$search", nonEmpty(options.search, "search"))
  }
  if (options && "includeHiddenFolders" in options && options.includeHiddenFolders !== undefined)
    params.set("includeHiddenFolders", String(options.includeHiddenFolders))
  return params.size ? `?${params}` : ""
}
export async function* mailPages<T extends { id: string }>(
  http: MicrosoftHttp,
  path: string,
  options?: RequestOptions,
  headers = mailHeaders()
): AsyncIterable<T> {
  const visited = new Set<string>()
  let next: string | undefined = path
  while (next) {
    const url = graphUrl(next)
    if (visited.has(url)) throw new MicrosoftProtocolError("Mail pagination repeated a nextLink.")
    visited.add(url)
    const result: GraphPage<T> = page(await http.json(url, { signal: options?.signal, headers }))
    yield* result.value
    next = result["@odata.nextLink"]
  }
}
export async function mailBytes(
  http: MicrosoftHttp,
  path: string,
  options?: RequestOptions
): Promise<Response> {
  const response = await http.request(path, { signal: options?.signal, headers: mailHeaders() })
  if (!response.ok) throw new MicrosoftApiError(response, await readResponseBody(response))
  return response
}
export async function accepted(response: Response): Promise<MailSendResult> {
  if (!response.ok) await readJson(response)
  if (response.status !== 202) {
    await response.body?.cancel()
    throw new MicrosoftProtocolError("Expected 202 Accepted for a mail submission.")
  }
  await response.body?.cancel()
  return {
    status: "accepted",
    ...(response.headers.get("request-id")
      ? { requestId: response.headers.get("request-id")! }
      : {}),
  }
}
