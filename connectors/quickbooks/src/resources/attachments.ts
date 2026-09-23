import { QuickBooksWriteError } from "../errors"
import type { createQuickBooksHttp } from "../http"
import { integer, listAll, pathId, quoted, readEntity, readQueryPage } from "../query"
import type {
  QuickBooksAttachment,
  QuickBooksAttachmentListOptions,
  QuickBooksAttachmentUpload,
} from "../types/attachments"
import type { QuickBooksPage } from "../types/query"
import type { QuickBooksWriteOptions } from "../types/writes"
import { isRecord, nonEmpty } from "../validation"

export interface QuickBooksAttachmentsResource {
  get(id: string): Promise<QuickBooksAttachment>
  list(options?: QuickBooksAttachmentListOptions): Promise<QuickBooksPage<QuickBooksAttachment>>
  listAll(options?: QuickBooksAttachmentListOptions): AsyncIterable<QuickBooksAttachment>
  /** Resolves a fresh temporary URL and downloads bytes without OAuth headers. */
  download(id: string): Promise<Uint8Array<ArrayBuffer>>
  upload(
    input: QuickBooksAttachmentUpload,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksAttachment>
}

export function createAttachmentsResource(
  http: Pick<Awaited<ReturnType<typeof createQuickBooksHttp>>, "get" | "download" | "upload">
): QuickBooksAttachmentsResource {
  const resource: QuickBooksAttachmentsResource = {
    get: (id) => readEntity(http, "Attachable", `attachable/${pathId(id)}`, id),
    list(options = {}) {
      for (const key of Object.keys(options))
        if (!["entity", "startPosition", "maxResults"].includes(key))
          throw new Error(`[SixbQuickBooks] Unsupported attachment list option: ${key}.`)
      const start = options.startPosition ?? 1
      const count = options.maxResults ?? 100
      integer(start, "startPosition", 1)
      integer(count, "maxResults", 1, 1000)
      const where = options.entity
        ? ` WHERE AttachableRef.EntityRef.Type = ${quoted(options.entity.type)} AND AttachableRef.EntityRef.value = ${quoted(options.entity.value)}`
        : ""
      return readQueryPage(
        http,
        "Attachable",
        `SELECT * FROM Attachable${where} STARTPOSITION ${start} MAXRESULTS ${count}`,
        start,
        count
      )
    },
    listAll: (options) => listAll(resource.list, options),
    async download(id) {
      const attachment = await resource.get(id)
      nonEmpty(
        attachment.TempDownloadUri,
        "attachment TempDownloadUri (note-only attachments have no file)"
      )
      return http.download(attachment.TempDownloadUri)
    },
    async upload(input, options = {}) {
      if (!(input.file instanceof Blob))
        throw new Error("[SixbQuickBooks] Attachment file must be a Blob.")
      nonEmpty(input.FileName, "FileName")
      const contentType = input.ContentType ?? input.file.type
      nonEmpty(contentType, "ContentType")
      if (input.Note !== undefined && typeof input.Note !== "string")
        throw new Error("[SixbQuickBooks] Note must be a string.")
      if (input.AttachableRef !== undefined) {
        if (!Array.isArray(input.AttachableRef))
          throw new Error("[SixbQuickBooks] AttachableRef must be an array.")
        for (const ref of input.AttachableRef) {
          nonEmpty(ref?.EntityRef?.type, "EntityRef.type")
          nonEmpty(ref?.EntityRef?.value, "EntityRef.value")
          if (ref.IncludeOnSend !== undefined && typeof ref.IncludeOnSend !== "boolean")
            throw new Error("[SixbQuickBooks] IncludeOnSend must be a boolean.")
        }
      }
      const requestId = options.requestId ?? crypto.randomUUID()
      nonEmpty(requestId, "requestId")
      if (requestId.length > 50)
        throw new Error("[SixbQuickBooks] requestId exceeds 50 characters.")
      const form = new FormData()
      form.append(
        "file_metadata_0",
        new Blob(
          [
            JSON.stringify({
              FileName: input.FileName,
              ContentType: contentType,
              Note: input.Note,
              AttachableRef: input.AttachableRef,
            }),
          ],
          { type: "application/json" }
        ),
        "attachment.json"
      )
      form.append(
        "file_content_0",
        input.file.slice(0, input.file.size, contentType),
        input.FileName
      )
      const body = await http.upload(form, requestId)
      const entries = isRecord(body) ? body.AttachableResponse : undefined
      const attachment =
        Array.isArray(entries) && entries.length === 1 && isRecord(entries[0])
          ? entries[0].Attachable
          : undefined
      if (!isRecord(attachment) || typeof attachment.Id !== "string" || !attachment.Id.trim())
        throw new QuickBooksWriteError(requestId, new Error("Invalid attachment upload response."))
      return attachment as unknown as QuickBooksAttachment
    },
  }
  return resource
}
