import { readResponseBody } from "@sixb/connector-rest"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../../errors"
import { isRecord } from "../../guards"
import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import { page } from "../../pagination"
import type { GraphPage, RequestOptions, SelectOptions } from "../../types/common"
import type { FileContent } from "../../types/files"
import type {
  MailAttachment,
  MailAttachmentSession,
  MailAttachmentUploadResult,
  MailFileOptions,
} from "../../types/mail"
import { httpsUrl, nonEmpty, resource, segment } from "../../validation"
import { mailBytes, mailHeaders, mailPages, mailQuery, messagePath } from "./common"

const SMALL_LIMIT = 3 * 1024 * 1024
const MAX_SIZE = 150 * 1024 * 1024
const CHUNK_SIZE = 10 * 320 * 1024
const attachmentsPath = (mailbox: string, messageId: string) =>
  `${messagePath(mailbox, messageId)}/attachments`

export class MicrosoftMailUploadError extends Error {
  readonly session: MailAttachmentSession
  readonly completionUnknown: boolean
  constructor(session: MailAttachmentSession, cause: unknown, completionUnknown: boolean) {
    super(
      `[SixbMicrosoft] Attachment upload interrupted. ${completionUnknown ? "The attachment may exist; inspect the message before restarting." : "Resume the existing session with the same complete file or cancel it."}`,
      { cause }
    )
    this.name = "MicrosoftMailUploadError"
    this.session = session
    this.completionUnknown = completionUnknown
  }
}
export interface MailAttachmentsResource {
  list(
    mailbox: string,
    messageId: string,
    options?: SelectOptions
  ): Promise<GraphPage<MailAttachment>>
  listAll(
    mailbox: string,
    messageId: string,
    options?: SelectOptions
  ): AsyncIterable<MailAttachment>
  get(
    mailbox: string,
    messageId: string,
    id: string,
    options?: SelectOptions
  ): Promise<MailAttachment>
  /** File bytes or MIME for item attachments. Reference attachments return Graph's 405. */
  downloadResponse(
    mailbox: string,
    messageId: string,
    id: string,
    options?: RequestOptions
  ): Promise<Response>
  download(
    mailbox: string,
    messageId: string,
    id: string,
    options?: RequestOptions
  ): Promise<Uint8Array>
  delete(mailbox: string, messageId: string, id: string, options?: RequestOptions): Promise<void>
  /** Adds a file to a draft. Large files use sequential Outlook upload sessions. */
  upload(
    mailbox: string,
    messageId: string,
    name: string,
    content: FileContent,
    options?: MailFileOptions
  ): Promise<MailAttachmentUploadResult>
  createSession(
    mailbox: string,
    messageId: string,
    name: string,
    size: number,
    options?: MailFileOptions
  ): Promise<MailAttachmentSession>
  /** Resume at the last acknowledged offset, using the same complete file. No implicit retries. */
  resume(
    session: MailAttachmentSession,
    content: FileContent,
    options?: RequestOptions
  ): Promise<MailAttachmentUploadResult>
  cancel(session: MailAttachmentSession, options?: RequestOptions): Promise<void>
}
function file(content: FileContent): Blob {
  if (content instanceof Blob) return content
  if (content instanceof Uint8Array) return new Blob([new Uint8Array(content)])
  if (content instanceof ArrayBuffer) return new Blob([content])
  throw new MicrosoftConfigurationError(
    "Attachment content must be a Blob, Uint8Array or ArrayBuffer."
  )
}
function metadata(name: string, options?: MailFileOptions) {
  nonEmpty(name, "attachment name")
  if (options?.isInline && !options.contentId)
    throw new MicrosoftConfigurationError("An inline file requires contentId.")
  return {
    name,
    ...(options?.contentType !== undefined
      ? { contentType: nonEmpty(options.contentType, "contentType") }
      : {}),
    ...(options?.isInline !== undefined ? { isInline: options.isInline } : {}),
    ...(options?.contentId !== undefined
      ? { contentId: nonEmpty(options.contentId, "contentId") }
      : {}),
  }
}
function sessionState(value: unknown, uploadUrl?: string): MailAttachmentSession {
  if (!isRecord(value)) throw new MicrosoftProtocolError("Invalid Outlook upload session.")
  const expirationDateTime = value.expirationDateTime ?? value.ExpirationDateTime
  const url = uploadUrl ?? value.uploadUrl
  const ranges = value.nextExpectedRanges
  if (
    typeof url !== "string" ||
    typeof expirationDateTime !== "string" ||
    !Number.isFinite(Date.parse(expirationDateTime)) ||
    !Array.isArray(ranges) ||
    !ranges.length ||
    ranges.some((range) => typeof range !== "string" || !/^\d+(?:-\d*)?$/.test(range))
  )
    throw new MicrosoftProtocolError(
      "Outlook upload session is missing its URL, expiry or offsets."
    )
  httpsUrl(url)
  return { uploadUrl: url, expirationDateTime, nextExpectedRanges: ranges }
}
function offset(session: MailAttachmentSession, size: number): number {
  const offsets = session.nextExpectedRanges.map((range) => {
    const [start, end] = range.split("-")
    const position = Number(start)
    if (
      !Number.isSafeInteger(position) ||
      position < 0 ||
      position >= size ||
      (end !== undefined &&
        end !== "" &&
        (!Number.isSafeInteger(Number(end)) || Number(end) < position || Number(end) >= size))
    )
      throw new MicrosoftProtocolError("Outlook upload offset does not match the file size.")
    return position
  })
  return Math.min(...offsets)
}
function uploadedId(response: Response): string {
  const location = response.headers.get("location")
  if (!location)
    throw new MicrosoftProtocolError("Completed Outlook upload did not return Location.")
  // Parse the documented Outlook OData location; never request it with Graph credentials.
  const url = httpsUrl(location)
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    throw new MicrosoftProtocolError("Invalid attachment Location encoding.")
  }
  const match = /\/Attachments\('((?:[^']|'')+)'\)\/?$/i.exec(path)
  if (!match)
    throw new MicrosoftProtocolError(
      "Completed Outlook upload returned an invalid attachment Location."
    )
  return match[1].replace(/''/g, "'")
}
export function attachmentsResource(http: MicrosoftHttp): MailAttachmentsResource {
  const attachments: MailAttachmentsResource = {
    async list(mailbox, messageId, options) {
      return page(
        await http.json(`${attachmentsPath(mailbox, messageId)}${mailQuery(options)}`, {
          signal: options?.signal,
          headers: mailHeaders(),
        })
      )
    },
    listAll(mailbox, messageId, options) {
      return mailPages(http, `${attachmentsPath(mailbox, messageId)}${mailQuery(options)}`, options)
    },
    async get(mailbox, messageId, id, options) {
      return resource<MailAttachment>(
        await http.json(
          `${attachmentsPath(mailbox, messageId)}/${segment(id, "attachmentId")}${mailQuery(options)}`,
          { signal: options?.signal, headers: mailHeaders() }
        )
      )
    },
    downloadResponse(mailbox, messageId, id, options) {
      return mailBytes(
        http,
        `${attachmentsPath(mailbox, messageId)}/${segment(id, "attachmentId")}/$value`,
        options
      )
    },
    async download(mailbox, messageId, id, options) {
      return new Uint8Array(
        await (await attachments.downloadResponse(mailbox, messageId, id, options)).arrayBuffer()
      )
    },
    async delete(mailbox, messageId, id, options) {
      await checkEmpty(
        await http.request(
          `${attachmentsPath(mailbox, messageId)}/${segment(id, "attachmentId")}`,
          { method: "DELETE", signal: options?.signal, headers: mailHeaders() }
        )
      )
    },
    async upload(mailbox, messageId, name, content, options) {
      const path = attachmentsPath(mailbox, messageId)
      const info = metadata(name, options)
      const data = file(content)
      if (data.size > MAX_SIZE)
        throw new MicrosoftConfigurationError(
          "An Outlook attachment cannot exceed 150 MiB; Exchange message limits also apply."
        )
      if (data.size < SMALL_LIMIT) {
        const result = resource(
          await http.json(path, {
            method: "POST",
            signal: options?.signal,
            headers: mailHeaders(),
            body: {
              "@odata.type": "#microsoft.graph.fileAttachment",
              ...info,
              contentType: info.contentType ?? (data.type || "application/octet-stream"),
              contentBytes: Buffer.from(await data.arrayBuffer()).toString("base64"),
            },
          })
        )
        return { id: result.id }
      }
      return attachments.resume(
        await attachments.createSession(mailbox, messageId, name, data.size, options),
        data,
        options
      )
    },
    async createSession(mailbox, messageId, name, size, options) {
      const path = attachmentsPath(mailbox, messageId)
      const info = metadata(name, options)
      if (!Number.isSafeInteger(size) || size < SMALL_LIMIT || size > MAX_SIZE)
        throw new MicrosoftConfigurationError(
          "Outlook attachment sessions require a size between 3 and 150 MiB."
        )
      return sessionState(
        await http.json(`${path}/createUploadSession`, {
          method: "POST",
          signal: options?.signal,
          headers: mailHeaders(),
          body: { AttachmentItem: { attachmentType: "file", ...info, size } },
        })
      )
    },
    async resume(session, content, options) {
      let current = sessionState(session)
      const data = file(content)
      if (data.size < SMALL_LIMIT || data.size > MAX_SIZE)
        throw new MicrosoftConfigurationError(
          "Outlook attachment sessions require the same complete file (3–150 MiB)."
        )
      const signal = options?.signal ? AbortSignal.any([http.signal, options.signal]) : http.signal
      let completionUnknown = false
      try {
        for (;;) {
          signal.throwIfAborted()
          const start = offset(current, data.size)
          const end = Math.min(start + CHUNK_SIZE, data.size)
          completionUnknown = end === data.size
          const response = await http.media(current.uploadUrl, {
            method: "PUT",
            signal,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(end - start),
              "Content-Range": `bytes ${start}-${end - 1}/${data.size}`,
            },
            body: data.slice(start, end),
          })
          if (response.status === 201) {
            await response.body?.cancel()
            if (end !== data.size)
              throw new MicrosoftProtocolError(
                "Outlook completed an attachment before all bytes were sent."
              )
            return { id: uploadedId(response) }
          }
          if (response.status !== 200) {
            if (response.status < 500 && response.status !== 416) completionUnknown = false
            throw new MicrosoftApiError(response, await readResponseBody(response))
          }
          current = sessionState(await readJson(response), current.uploadUrl)
          completionUnknown = false
          if (offset(current, data.size) < end)
            throw new MicrosoftProtocolError("Outlook attachment acknowledgement did not advance.")
        }
      } catch (cause) {
        throw new MicrosoftMailUploadError(current, cause, completionUnknown)
      }
    },
    async cancel(session, options) {
      await checkEmpty(
        await http.media(httpsUrl(session.uploadUrl).href, {
          method: "DELETE",
          signal: options?.signal,
        })
      )
    },
  }
  return attachments
}
