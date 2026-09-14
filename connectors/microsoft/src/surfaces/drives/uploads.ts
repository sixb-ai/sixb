import { parseRetryAfter, readResponseBody } from "@sixb/connector-rest"
import {
  MicrosoftApiError,
  MicrosoftConfigurationError,
  MicrosoftProtocolError,
} from "../../errors"
import { isRecord } from "../../guards"
import { checkEmpty, type MicrosoftHttp, readJson } from "../../http"
import type { ConflictBehavior, RequestOptions, WriteOptions } from "../../types/common"
import type {
  DriveItem,
  FileContent,
  UploadSession,
  UploadStatus,
  UploadTransferOptions,
} from "../../types/files"
import { fileName, httpsUrl, resource } from "../../validation"
import { conflict, writeHeaders } from "./items"
import { itemPath } from "./paths"

export type UploadTarget =
  | { readonly parentId: string; readonly name: string; readonly itemId?: never }
  | { readonly itemId: string; readonly parentId?: never; readonly name?: never }

export interface CreateUploadSessionOptions extends RequestOptions {
  /** Checked when creating the session (412 on mismatch); does not promise a commit-time lock. */
  readonly ifMatch?: WriteOptions["ifMatch"]
  /** Defaults to fail for a new file and replace for an existing item ID. */
  readonly conflictBehavior?: ConflictBehavior
}

export interface UploadOptions extends CreateUploadSessionOptions, UploadTransferOptions {
  /** Single-PUT Content-Type. Graph infers the final MIME type for session uploads. */
  readonly contentType?: string
}

export class MicrosoftUploadError extends Error {
  readonly session: UploadSession
  /** The last PUT may have committed. Reconcile the destination before starting another upload. */
  readonly completionUnknown: boolean

  constructor(session: UploadSession, cause: unknown, completionUnknown: boolean) {
    super(
      `[SixbMicrosoft] Upload interrupted. ${completionUnknown ? "Completion may have occurred; check the destination before restarting." : "The session can be inspected, resumed or cancelled."}`,
      { cause }
    )
    this.name = "MicrosoftUploadError"
    this.session = session
    this.completionUnknown = completionUnknown
  }
}

export interface DriveUploadsResource {
  upload(
    driveId: string,
    target: UploadTarget,
    content: FileContent,
    options?: UploadOptions
  ): Promise<DriveItem>
  createSession(
    driveId: string,
    target: UploadTarget,
    options?: CreateUploadSessionOptions
  ): Promise<UploadSession>
  getStatus(session: UploadSession, options?: RequestOptions): Promise<UploadStatus>
  /** Content must be the same complete file used when starting the session. */
  resume(
    session: UploadSession,
    content: FileContent,
    options?: UploadTransferOptions
  ): Promise<DriveItem>
  cancel(session: UploadSession, options?: RequestOptions): Promise<void>
}

const QUANTUM = 320 * 1024
const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024
const MAX_RECOVERIES = 2

function blob(content: FileContent): Blob {
  if (content instanceof Blob) return content
  if (content instanceof Uint8Array) return new Blob([new Uint8Array(content)])
  if (content instanceof ArrayBuffer) return new Blob([content])
  throw new MicrosoftConfigurationError(
    "content must be a Blob (including Bun.file), Uint8Array or ArrayBuffer."
  )
}

function chunkSize(options?: UploadTransferOptions): number {
  const size = options?.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size >= 60 * 1024 * 1024 ||
    size % QUANTUM !== 0
  ) {
    throw new MicrosoftConfigurationError(
      "chunkSize must be a positive multiple of 320 KiB, strictly below 60 MiB."
    )
  }
  return size
}

function targetPath(driveId: string, target: UploadTarget): string {
  if (target.itemId !== undefined) {
    if (target.parentId !== undefined || target.name !== undefined)
      throw new MicrosoftConfigurationError(
        "Choose either itemId or parentId and name for an upload."
      )
    return itemPath(driveId, target.itemId)
  }
  return `${itemPath(driveId, target.parentId)}:/${fileName(target.name)}:`
}

function status(value: unknown): UploadStatus {
  if (
    !isRecord(value) ||
    typeof value.expirationDateTime !== "string" ||
    !Number.isFinite(Date.parse(value.expirationDateTime)) ||
    !Array.isArray(value.nextExpectedRanges) ||
    value.nextExpectedRanges.length === 0 ||
    value.nextExpectedRanges.some((range) => typeof range !== "string" || !/^\d+-\d*$/.test(range))
  ) {
    throw new MicrosoftProtocolError(
      "Upload status is missing valid expirationDateTime or nextExpectedRanges."
    )
  }
  return value as unknown as UploadStatus
}

function sessionUrl(session: UploadSession): string {
  return httpsUrl(session.uploadUrl).href
}

function missingRange(state: UploadStatus, size: number): { start: number; end: number } {
  const ranges = state.nextExpectedRanges
    .map((range) => {
      const [start, end] = range.split("-")
      return { start: Number(start), end: end ? Number(end) + 1 : size }
    })
    .sort((a, b) => a.start - b.start)
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.start >= range.end ||
      range.end > size
    ) {
      throw new MicrosoftProtocolError("Upload ranges do not match the supplied file size.")
    }
  }
  return ranges[0]
}

export function uploadsResource(http: MicrosoftHttp): DriveUploadsResource {
  const transfer = async (
    session: UploadSession,
    content: Blob,
    options: UploadTransferOptions | undefined,
    initial: UploadStatus
  ): Promise<DriveItem> => {
    options = {
      ...options,
      signal: options?.signal ? AbortSignal.any([http.signal, options.signal]) : http.signal,
    }
    const size = chunkSize(options)
    const url = sessionUrl(session)
    let state = initial
    let recoveries = 0
    let completionUnknown = false
    try {
      for (;;) {
        options?.signal?.throwIfAborted()
        const range = missingRange(state, content.size)
        // Graph reports missing offsets, not fragment sizes. Like Microsoft's SDK,
        // choose our own aligned length even when a reported range ends inside it.
        const end = Math.min(range.start + size, content.size)
        let response: Response | undefined
        try {
          completionUnknown = end === content.size
          response = await http.media(url, {
            method: "PUT",
            signal: options?.signal,
            headers: {
              "Content-Length": String(end - range.start),
              "Content-Range": `bytes ${range.start}-${end - 1}/${content.size}`,
              "Content-Type": "application/octet-stream",
            },
            body: content.slice(range.start, end),
          })
        } catch (error) {
          options?.signal?.throwIfAborted()
          if (recoveries >= MAX_RECOVERIES) throw error
        }
        if (response?.status === 200 || response?.status === 201) {
          if (end !== content.size) {
            await response.body?.cancel()
            throw new MicrosoftProtocolError("Upload completed before all file bytes were sent.")
          }
          return resource(await readJson(response))
        }
        if (response?.status === 202) {
          completionUnknown = false
          state = status(await readJson(response))
          const next = missingRange(state, content.size)
          if (next.start < end)
            throw new MicrosoftProtocolError(
              "Upload acknowledgement did not advance to the next fragment."
            )
          recoveries = 0
          continue
        }
        const retry =
          response === undefined ||
          response.status === 416 ||
          response.status === 429 ||
          response.status >= 500
        if (response && response.status < 500 && response.status !== 416) completionUnknown = false
        if (!retry || recoveries >= MAX_RECOVERIES) {
          if (response) throw new MicrosoftApiError(response, await readResponseBody(response))
          throw new MicrosoftProtocolError("Upload recovery attempts exhausted.")
        }
        const delay =
          response?.status === 416
            ? 0
            : (parseRetryAfter(response?.headers.get("retry-after") ?? null) ??
              1000 * 2 ** recoveries)
        await response?.body?.cancel()
        recoveries++
        // Query committed ranges before replaying a PUT. A lost final response followed by
        // a missing session is ambiguous: propagate it, never create a second upload.
        await wait(delay, options?.signal)
        state = await uploads.getStatus(session, options)
        completionUnknown = false
      }
    } catch (cause) {
      throw new MicrosoftUploadError(
        {
          ...session,
          expirationDateTime: state.expirationDateTime,
          nextExpectedRanges: state.nextExpectedRanges,
        },
        cause,
        completionUnknown
      )
    }
  }

  const uploads: DriveUploadsResource = {
    async upload(driveId, target, content, options) {
      const path = targetPath(driveId, target)
      writeHeaders(options)
      chunkSize(options)
      const data = blob(content)
      const behavior = conflict(options?.conflictBehavior, target.itemId ? "replace" : "fail")
      if (data.size <= DEFAULT_CHUNK_SIZE && options?.ifMatch === undefined) {
        const params = new URLSearchParams({ "@microsoft.graph.conflictBehavior": behavior })
        return resource(
          await http.json(`${path}/content?${params}`, {
            method: "PUT",
            signal: options?.signal,
            headers: {
              "Content-Type": options?.contentType ?? (data.type || "application/octet-stream"),
            },
            body: data,
          })
        )
      }
      if (data.size === 0)
        throw new MicrosoftConfigurationError(
          "Conditional empty uploads are not supported; omit ifMatch or write non-empty content."
        )
      const session = await uploads.createSession(driveId, target, options)
      return transfer(session, data, options, {
        expirationDateTime: session.expirationDateTime,
        nextExpectedRanges: ["0-"],
      })
    },
    async createSession(driveId, target, options) {
      const path = targetPath(driveId, target)
      const body = await http.json(`${path}/createUploadSession`, {
        method: "POST",
        signal: options?.signal,
        headers: writeHeaders(options),
        body: {
          item: {
            "@microsoft.graph.conflictBehavior": conflict(
              options?.conflictBehavior,
              target.itemId ? "replace" : "fail"
            ),
            ...(target.name ? { name: target.name } : {}),
          },
        },
      })
      if (
        !isRecord(body) ||
        typeof body.uploadUrl !== "string" ||
        typeof body.expirationDateTime !== "string" ||
        !Number.isFinite(Date.parse(body.expirationDateTime))
      )
        throw new MicrosoftProtocolError("Graph returned an invalid upload session.")
      httpsUrl(body.uploadUrl)
      return body as unknown as UploadSession
    },
    async getStatus(session, options) {
      return status(
        await readJson(await http.media(sessionUrl(session), { signal: options?.signal }))
      )
    },
    async resume(session, content, options) {
      chunkSize(options)
      const data = blob(content)
      if (!data.size)
        throw new MicrosoftConfigurationError("An upload session requires non-empty content.")
      return transfer(session, data, options, await uploads.getStatus(session, options))
    },
    async cancel(session, options) {
      await checkEmpty(
        await http.media(sessionUrl(session), { method: "DELETE", signal: options?.signal })
      )
    },
  }
  return uploads
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
