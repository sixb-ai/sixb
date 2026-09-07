import { posix } from "node:path"
import type { AgentFileDataProjection, BlobInfo, BlobStorage, FileRef } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import type { LanguageModel } from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { NEVER_ABORTED_SIGNAL, waitForAbort } from "./abort"
import { fileContentKey } from "./file-ref"
import { type AgentAttachmentLimits, processAgentImageAttachment } from "./image-attachments"

const DEFAULT_AGENT_ATTACHMENT_LIMITS: AgentAttachmentLimits = {
  textInlineMaxBytes: 50 * 1024,
  textInlineMaxLines: 2_000,
  imageMaxWidth: 2_000,
  imageMaxHeight: 2_000,
  imageMaxBase64Bytes: 4.5 * 1024 * 1024,
  imageJpegQualities: [80, 85, 70, 55, 40],
  imageMaxPixels: 4096 * 4096,
  sandboxFileMaxBytes: 25 * 1024 * 1024,
  sandboxTotalMaxBytes: 100 * 1024 * 1024,
}
const TEXT_INLINE_TOTAL_MAX_BYTES = 200 * 1024
const MAX_ASSISTANT_ATTACHMENTS = 50

export interface PreparedAgentAttachmentContext {
  readonly entries: readonly PreparedAgentAttachment[]
  readonly promptTextByPartKey: ReadonlyMap<string, string>
  readonly modelFileDataByPartKey: ReadonlyMap<string, AgentFileDataProjection>
  readonly sandboxFiles: readonly PreparedSandboxAttachmentFile[]
  readonly manifestJson: string
}

export interface PreparedAgentAttachment {
  readonly key: string
  readonly messageId: string
  readonly partIndex: number
  readonly fileRef: FileRef
  readonly fileName: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly contentPath: string
  readonly contentUrl: string
  readonly sandboxPath?: string
  readonly inlineDisposition: "image" | "text" | "metadata-only" | "omitted"
  readonly notes: readonly string[]
}

export interface PreparedSandboxAttachmentFile {
  readonly key: string
  readonly path: string
  readonly bytes: Uint8Array
  readonly fileRef: FileRef
}

export interface PreparedAgentToolFileProjection {
  readonly promptText: string
  readonly modelFileData?: AgentFileDataProjection
}

interface AttachmentWorkItem {
  readonly message: AgentMessageRecord
  readonly fileRef: FileRef
  readonly partIndex: number
  readonly key: string
  readonly contentPath: string
  readonly sandboxName: string
  readonly inlineContent: boolean
  readonly origin: "message-file" | "tool-result-file"
}

export async function prepareAgentAttachments(input: {
  readonly projectId: string
  readonly threadId: string
  readonly messages: readonly AgentMessageRecord[]
  readonly blobStorage: BlobStorage
  readonly apiBaseUrl: string
  readonly inlineImages: boolean
  readonly signal?: AbortSignal
}): Promise<PreparedAgentAttachmentContext> {
  const promptTextByPartKey = new Map<string, string>()
  const modelFileDataByPartKey = new Map<string, AgentFileDataProjection>()
  const sandboxFiles: PreparedSandboxAttachmentFile[] = []
  const entries: PreparedAgentAttachment[] = []
  let sandboxBytes = 0
  let textInlineBytes = 0

  for (const item of fileWorkItems(input.messages)) {
    input.signal?.throwIfAborted()
    const prepared = await prepareOneAttachment({
      ...input,
      item,
      sandboxBytes,
      textInlineBytes,
    })
    sandboxBytes += prepared.sandboxBytesAdded
    textInlineBytes += prepared.textInlineBytesAdded
    entries.push(prepared.entry)
    promptTextByPartKey.set(prepared.entry.key, prepared.promptText)
    if (prepared.modelFileData) {
      modelFileDataByPartKey.set(prepared.entry.key, prepared.modelFileData)
    }
    if (prepared.sandboxFile) {
      sandboxFiles.push(prepared.sandboxFile)
    }
  }

  return {
    entries,
    promptTextByPartKey,
    modelFileDataByPartKey,
    sandboxFiles,
    manifestJson: JSON.stringify(
      {
        projectId: input.projectId,
        threadId: input.threadId,
        attachments: entries.map((entry) => manifestEntry(entry)),
      },
      null,
      2
    ),
  }
}

/** Build the bounded, ephemeral projection of a tool-created file for the next model step. */
export async function prepareAgentToolFileProjection(input: {
  readonly fileRef: FileRef
  readonly blobStorage: BlobStorage
  readonly inlineImages: boolean
  readonly signal?: AbortSignal
  readonly sandboxPath?: string
  readonly imageOmissionNote?: string
}): Promise<PreparedAgentToolFileProjection> {
  const { fileRef } = input
  const signal = input.signal ?? NEVER_ABORTED_SIGNAL
  signal.throwIfAborted()
  const fileName = fileNameFor(fileRef)
  const mediaType = normalizedMediaType(fileRef.mediaType) ?? "application/octet-stream"
  const notes: string[] = []
  let textExcerpt: string | undefined
  let modelFileData: AgentFileDataProjection | undefined

  const stat = await safeBlobStat(input.blobStorage, fileRef, notes, signal)
  if (!stat) {
    notes.push("[File omitted: blob content is not available or no longer matches this FileRef.]")
  } else {
    const shouldReadForText = shouldAttemptTextInline(mediaType, fileName, stat.sizeBytes)
    const shouldReadForImage = input.inlineImages && shouldAttemptImageInline(mediaType, fileName)
    const readLimit = shouldReadForText
      ? DEFAULT_AGENT_ATTACHMENT_LIMITS.textInlineMaxBytes + 4
      : shouldReadForImage
        ? DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxFileMaxBytes
        : 0

    if (readLimit > 0) {
      const read = await readBlobBytes(input.blobStorage, fileRef.blobId, readLimit, signal, {
        allowPrefix: shouldReadForText,
      })
      if (read.ok) {
        const text = shouldReadForText
          ? maybeTextExcerpt(read.bytes, mediaType, fileName, stat.sizeBytes, readLimit - 4)
          : undefined
        if (text) {
          textExcerpt = text.text
          if (text.truncated) {
            notes.push("[Text file truncated for model input.]")
          }
        } else if (shouldReadForImage) {
          const image = await maybeImageData({
            bytes: read.bytes,
            mediaType,
            fileName,
            inlineImages: true,
            hasImageHint: true,
            signal,
          })
          if (image?.ok) {
            notes.push(...image.notes)
            modelFileData = {
              data: image.dataUrl,
              mediaType: image.mediaType,
              filename: fileName,
            }
          } else if (image) {
            notes.push(...image.notes)
          }
        }
      } else if (read.reason === "too_large") {
        notes.push("[File not projected inline: file exceeds the attachment read limit.]")
      } else {
        notes.push(`[File not projected inline: ${read.reason}.]`)
      }
    }

    if (!input.inlineImages && hasImageHint(mediaType, fileName)) {
      notes.push(
        input.imageOmissionNote ??
          "[Image not inlined: the selected model does not advertise image input support.]"
      )
    }
    if (!textExcerpt && !modelFileData && notes.length === 0) {
      notes.push("[File contents are available through its sandbox path.]")
    }
  }

  const body = [
    ...notes,
    ...(textExcerpt === undefined ? [] : ["<content>", textExcerpt, "</content>"]),
  ].join("\n")
  const sandboxPathAttribute =
    input.sandboxPath === undefined ? "" : ` sandboxPath="${escapeXmlAttribute(input.sandboxPath)}"`
  const promptText = `<tool_file name="${escapeXmlAttribute(fileName)}" mediaType="${escapeXmlAttribute(
    mediaType
  )}" sizeBytes="${fileRef.sizeBytes}"${sandboxPathAttribute}>\n${body}\n</tool_file>`
  return {
    promptText,
    ...(modelFileData === undefined ? {} : { modelFileData }),
  }
}

function fileWorkItems(messages: readonly AgentMessageRecord[]): AttachmentWorkItem[] {
  const items: AttachmentWorkItem[] = []
  const currentUserMessageId = latestUserMessageId(messages)
  for (const message of messages) {
    message.parts.forEach((part, partIndex) => {
      if (part.type === "file") {
        items.push({
          message,
          fileRef: part.fileRef,
          partIndex,
          key: attachmentKey(message.id, partIndex),
          contentPath: `/parts/${partIndex}/fileRef`,
          sandboxName: String(partIndex),
          inlineContent: message.role === "user" && message.id === currentUserMessageId,
          origin: "message-file",
        })
      } else if (
        part.type === "tool-call" &&
        part.state === "output-available" &&
        isAgentToolResult(part.output)
      ) {
        part.output.content.forEach((contentPart, contentIndex) => {
          if (contentPart.type !== "file") return
          items.push({
            message,
            fileRef: contentPart.fileRef,
            partIndex,
            key: toolResultAttachmentKey(message.id, partIndex, contentIndex),
            contentPath: `/parts/${partIndex}/output/content/${contentIndex}/fileRef`,
            sandboxName: `tool-${partIndex}-${contentIndex}`,
            inlineContent: false,
            origin: "tool-result-file",
          })
        })
      }
    })
  }

  const toolFilesByMessage = new Set(
    items
      .filter((item) => item.origin === "tool-result-file")
      .map((item) => messageFileIdentity(item.message.id, item.fileRef))
  )
  const deduplicated = items.filter(
    (item) =>
      item.origin === "tool-result-file" ||
      item.message.role !== "assistant" ||
      !toolFilesByMessage.has(messageFileIdentity(item.message.id, item.fileRef))
  )
  const retainedAssistantKeys = new Set(
    deduplicated
      .filter((item) => item.message.role === "assistant")
      .slice(-MAX_ASSISTANT_ATTACHMENTS)
      .map((item) => item.key)
  )
  return deduplicated.filter(
    (item) => item.message.role !== "assistant" || retainedAssistantKeys.has(item.key)
  )
}

function latestUserMessageId(messages: readonly AgentMessageRecord[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") return message.id
  }
  return undefined
}

function messageFileIdentity(messageId: string, fileRef: FileRef): string {
  return JSON.stringify([messageId, fileContentKey(fileRef)])
}

async function prepareOneAttachment(input: {
  readonly projectId: string
  readonly threadId: string
  readonly item: AttachmentWorkItem
  readonly blobStorage: BlobStorage
  readonly apiBaseUrl: string
  readonly inlineImages: boolean
  readonly sandboxBytes: number
  readonly textInlineBytes: number
  readonly signal?: AbortSignal
}): Promise<{
  readonly entry: PreparedAgentAttachment
  readonly promptText: string
  readonly modelFileData?: AgentFileDataProjection
  readonly sandboxFile?: PreparedSandboxAttachmentFile
  readonly sandboxBytesAdded: number
  readonly textInlineBytesAdded: number
}> {
  const { item } = input
  const signal = input.signal ?? NEVER_ABORTED_SIGNAL
  signal.throwIfAborted()
  const key = item.key
  const fileRef = item.fileRef
  const fileName = fileNameFor(fileRef)
  const mediaType = normalizedMediaType(fileRef.mediaType) ?? "application/octet-stream"
  const contentPath = item.contentPath
  const contentUrl = attachmentContentUrl({
    apiBaseUrl: input.apiBaseUrl,
    threadId: input.threadId,
    messageId: item.message.id,
    contentPath,
  })
  const notes: string[] = []
  let bytes: Uint8Array | undefined
  let inlineDisposition: PreparedAgentAttachment["inlineDisposition"] = "metadata-only"
  let sandboxPath: string | undefined
  let sandboxFile: PreparedSandboxAttachmentFile | undefined
  let sandboxBytesAdded = 0
  let textExcerpt: string | undefined
  let textInlineBytesAdded = 0
  let modelFileData: AgentFileDataProjection | undefined

  const stat = await safeBlobStat(input.blobStorage, fileRef, notes, signal)
  if (!stat) {
    inlineDisposition = "omitted"
    notes.push("[File omitted: blob content is not available or no longer matches this FileRef.]")
  } else {
    const canMaterializeFile = stat.sizeBytes <= DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxFileMaxBytes
    const canMaterializeTotal =
      input.sandboxBytes + stat.sizeBytes <= DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxTotalMaxBytes
    const mayInlineContent = item.inlineContent
    const remainingTextBytes = Math.max(0, TEXT_INLINE_TOTAL_MAX_BYTES - input.textInlineBytes)
    const shouldReadForText =
      mayInlineContent &&
      remainingTextBytes > 0 &&
      shouldAttemptTextInline(mediaType, fileName, stat.sizeBytes)
    const shouldReadForImage =
      mayInlineContent && input.inlineImages && shouldAttemptImageInline(mediaType, fileName)
    const needsFullBytes = canMaterializeFile && canMaterializeTotal
    const readLimit = needsFullBytes
      ? stat.sizeBytes
      : shouldReadForText
        ? Math.min(DEFAULT_AGENT_ATTACHMENT_LIMITS.textInlineMaxBytes, remainingTextBytes) + 4
        : shouldReadForImage
          ? DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxFileMaxBytes
          : 0

    if (needsFullBytes || readLimit > 0) {
      const read = await readBlobBytes(input.blobStorage, fileRef.blobId, readLimit, signal, {
        allowPrefix: shouldReadForText && !needsFullBytes,
      })
      if (read.ok) {
        bytes = read.bytes
      } else if (read.reason === "too_large") {
        notes.push("[File not read inline: file exceeds the attachment read limit.]")
      } else {
        notes.push(`[File not read inline: ${read.reason}.]`)
      }
    }

    if (bytes && needsFullBytes && bytes.byteLength === stat.sizeBytes) {
      sandboxPath = sandboxAttachmentPath(item.message.id, item.sandboxName, fileName)
      sandboxFile = { key, path: sandboxPath, bytes, fileRef }
      sandboxBytesAdded = stat.sizeBytes
    } else if (!canMaterializeFile) {
      notes.push("[File not materialized in sandbox: file exceeds the per-file sandbox limit.]")
    } else if (!canMaterializeTotal) {
      notes.push("[File not materialized in sandbox: attachment sandbox budget exhausted.]")
    }

    if (bytes) {
      const text =
        mayInlineContent && remainingTextBytes > 0
          ? maybeTextExcerpt(bytes, mediaType, fileName, stat.sizeBytes, remainingTextBytes)
          : undefined
      if (text) {
        textExcerpt = text.text
        textInlineBytesAdded = Buffer.byteLength(text.text, "utf-8")
        inlineDisposition = "text"
        if (text.truncated) {
          notes.push(
            `[Text attachment truncated: showing first ${text.linesShown} line(s) within ${formatBytes(
              Math.min(DEFAULT_AGENT_ATTACHMENT_LIMITS.textInlineMaxBytes, remainingTextBytes)
            )}. Full file is available through the sandbox path or content URL.]`
          )
        }
      }

      if (!textExcerpt) {
        const image = await maybeImageData({
          bytes,
          mediaType,
          fileName,
          inlineImages: mayInlineContent && input.inlineImages,
          hasImageHint: hasImageHint(mediaType, fileName),
          signal,
        })
        if (image) {
          if (image.ok) {
            inlineDisposition = "image"
            notes.push(...image.notes)
            modelFileData = {
              data: image.dataUrl,
              mediaType: image.mediaType,
              filename: fileName,
            }
          } else if (image.notes.length > 0) {
            notes.push(...image.notes)
          }
        }
      } else if (hasImageHint(mediaType, fileName)) {
        notes.push("[Image not inlined: attachment was treated as text based on its content.]")
      }
    }

    if (mayInlineContent && !input.inlineImages && hasImageHint(mediaType, fileName)) {
      notes.push("[Image not inlined: the selected model does not advertise image input support.]")
    }

    if (inlineDisposition === "metadata-only" && notes.length === 0) {
      notes.push(
        !item.inlineContent
          ? "[Historical file kept as metadata: use view_file with the sandbox path when its contents are needed.]"
          : remainingTextBytes === 0 && shouldAttemptTextInline(mediaType, fileName, stat.sizeBytes)
            ? "[File not inlined: the attachment text budget is exhausted; use the sandbox path or content URL.]"
            : "[File not inlined: available through the sandbox path or content URL.]"
      )
    }
  }

  const entry: PreparedAgentAttachment = {
    key,
    messageId: item.message.id,
    partIndex: item.partIndex,
    fileRef,
    fileName,
    mediaType,
    sizeBytes: fileRef.sizeBytes,
    contentPath,
    contentUrl,
    ...(sandboxPath === undefined ? {} : { sandboxPath }),
    inlineDisposition,
    notes,
  }

  return {
    entry,
    promptText: attachmentPromptText(entry, textExcerpt),
    ...(modelFileData === undefined ? {} : { modelFileData }),
    ...(sandboxFile === undefined ? {} : { sandboxFile }),
    sandboxBytesAdded,
    textInlineBytesAdded,
  }
}

async function safeBlobStat(
  blobStorage: BlobStorage,
  fileRef: FileRef,
  notes: string[],
  signal: AbortSignal
): Promise<BlobInfo | null> {
  signal.throwIfAborted()
  let stat: BlobInfo | null
  try {
    stat = await waitForAbort(blobStorage.stat(fileRef.blobId), signal)
  } catch (error) {
    signal.throwIfAborted()
    console.error("[SixbAgentWorker] Failed to inspect an attachment blob.", error)
    notes.push("[File omitted: blob storage metadata is unavailable.]")
    return null
  }
  if (!stat || !blobMatchesFileRef(stat, fileRef)) {
    return null
  }
  return stat
}

function blobMatchesFileRef(stat: BlobInfo, fileRef: FileRef): boolean {
  return (
    stat.blobId === fileRef.blobId &&
    stat.digest === fileRef.digest &&
    stat.sizeBytes === fileRef.sizeBytes
  )
}

async function readBlobBytes(
  blobStorage: BlobStorage,
  blobId: string,
  maxBytes: number,
  signal: AbortSignal,
  options: { readonly allowPrefix?: boolean } = {}
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string }
> {
  signal.throwIfAborted()
  let stream: ReadableStream<Uint8Array>
  try {
    stream = await waitForAbort(blobStorage.open(blobId), signal)
  } catch (error) {
    signal.throwIfAborted()
    console.error("[SixbAgentWorker] Failed to open an attachment blob.", error)
    return { ok: false, reason: "blob content is unavailable" }
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const cancelOnAbort = () => {
    void reader.cancel(signal.reason)
  }
  signal.addEventListener("abort", cancelOnAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        if (options.allowPrefix) {
          if (remaining > 0) chunks.push(value.subarray(0, remaining))
          total = maxBytes
          await reader.cancel().catch(() => {})
          break
        }
        await reader.cancel().catch(() => {})
        return { ok: false, reason: "too_large" }
      }
      total += value.byteLength
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }

  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: result }
}

function shouldAttemptTextInline(mediaType: string, fileName: string, sizeBytes: number): boolean {
  return (
    sizeBytes <= DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxFileMaxBytes &&
    (isTextMediaType(mediaType) || looksLikeTextFileName(fileName))
  )
}

function shouldAttemptImageInline(mediaType: string, fileName: string): boolean {
  return hasImageHint(mediaType, fileName)
}

function maybeTextExcerpt(
  bytes: Uint8Array,
  mediaType: string,
  fileName: string,
  sizeBytes: number,
  maxBytes: number
): { readonly text: string; readonly truncated: boolean; readonly linesShown: number } | undefined {
  const declaredText = isTextMediaType(mediaType) || looksLikeTextFileName(fileName)
  if (!declaredText && !looksLikeUtf8Text(bytes)) {
    return undefined
  }

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: !declaredText }).decode(
      bytes.subarray(0, Math.min(bytes.byteLength, maxBytes + 4))
    )
  } catch {
    return undefined
  }

  const truncated = truncateText(text, {
    ...DEFAULT_AGENT_ATTACHMENT_LIMITS,
    textInlineMaxBytes: Math.min(DEFAULT_AGENT_ATTACHMENT_LIMITS.textInlineMaxBytes, maxBytes),
  })
  return {
    text: truncated.text,
    truncated: truncated.truncated || sizeBytes > bytes.byteLength,
    linesShown: truncated.linesShown,
  }
}

function truncateText(
  value: string,
  limits: AgentAttachmentLimits
): { readonly text: string; readonly truncated: boolean; readonly linesShown: number } {
  const lines = value.split("\n")
  const out: string[] = []
  let bytes = 0
  let truncated = false

  for (const line of lines) {
    if (out.length >= limits.textInlineMaxLines) {
      truncated = true
      break
    }
    const separatorBytes = out.length === 0 ? 0 : 1
    const lineBytes = Buffer.byteLength(line, "utf-8") + separatorBytes
    if (bytes + lineBytes > limits.textInlineMaxBytes) {
      truncated = true
      break
    }
    out.push(line)
    bytes += lineBytes
  }

  return { text: out.join("\n"), truncated, linesShown: out.length }
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return true
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  const sampleLength = Math.min(bytes.length, 1024)
  let control = 0
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index]
    if (byte !== 9 && byte !== 10 && byte !== 13 && byte < 32) {
      control += 1
    }
  }
  return control / sampleLength < 0.02
}

async function maybeImageData(input: {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly fileName: string
  readonly inlineImages: boolean
  readonly hasImageHint: boolean
  readonly signal: AbortSignal
}): Promise<
  | {
      readonly ok: true
      readonly dataUrl: URL
      readonly mediaType: string
      readonly notes: readonly string[]
    }
  | { readonly ok: false; readonly notes: readonly string[] }
  | undefined
> {
  if (!input.inlineImages) {
    return undefined
  }

  input.signal.throwIfAborted()
  const image = await processAgentImageAttachment({
    bytes: input.bytes,
    declaredMediaType: input.mediaType,
    fileName: input.fileName,
    limits: DEFAULT_AGENT_ATTACHMENT_LIMITS,
    signal: input.signal,
  })
  input.signal.throwIfAborted()
  if (!image.ok) {
    return input.hasImageHint ? { ok: false, notes: image.notes } : undefined
  }
  return {
    ok: true,
    dataUrl: image.dataUrl,
    mediaType: image.mediaType,
    notes: image.notes,
  }
}

export function modelSupportsInlineImages(model: LanguageModel): boolean {
  const { inputMediaTypes } = model.definition.capabilities
  return (
    inputMediaTypes === "any" ||
    inputMediaTypes?.some((mediaType) => mediaType.toLowerCase().startsWith("image/")) === true
  )
}

export function attachmentKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
}

export function toolResultAttachmentKey(
  messageId: string,
  partIndex: number,
  contentIndex: number
): string {
  return `${messageId}:${partIndex}:tool-result:${contentIndex}`
}

function attachmentPromptText(
  entry: PreparedAgentAttachment,
  textExcerpt: string | undefined
): string {
  const attrs = [
    `messageId="${escapeXmlAttribute(entry.messageId)}"`,
    `partIndex="${entry.partIndex}"`,
    `name="${escapeXmlAttribute(entry.fileName)}"`,
    `mediaType="${escapeXmlAttribute(entry.mediaType)}"`,
    `sizeBytes="${entry.sizeBytes}"`,
    `contentUrl="${escapeXmlAttribute(entry.contentUrl)}"`,
    ...(entry.sandboxPath ? [`sandboxPath="${escapeXmlAttribute(entry.sandboxPath)}"`] : []),
  ].join(" ")
  const body = [
    ...entry.notes,
    ...(textExcerpt === undefined ? [] : ["<content>", textExcerpt, "</content>"]),
  ].join("\n")
  return `<attachment ${attrs}>\n${body}\n</attachment>`
}

function manifestEntry(entry: PreparedAgentAttachment) {
  return {
    key: entry.key,
    messageId: entry.messageId,
    partIndex: entry.partIndex,
    fileName: entry.fileName,
    mediaType: entry.mediaType,
    sizeBytes: entry.sizeBytes,
    digest: entry.fileRef.digest,
    contentPath: entry.contentPath,
    contentUrl: entry.contentUrl,
    ...(entry.sandboxPath === undefined ? {} : { sandboxPath: entry.sandboxPath }),
    inlineDisposition: entry.inlineDisposition,
    notes: entry.notes,
  }
}

function attachmentContentUrl(input: {
  readonly apiBaseUrl: string
  readonly threadId: string
  readonly messageId: string
  readonly contentPath: string
}): string {
  const base = input.apiBaseUrl.replace(/\/+$/, "")
  return `${base}/api/agent-threads/${encodeURIComponent(
    input.threadId
  )}/messages/${encodeURIComponent(input.messageId)}/files/content?path=${encodeURIComponent(
    input.contentPath
  )}`
}

function sandboxAttachmentPath(messageId: string, sandboxName: string, fileName: string): string {
  return posix.join(
    ".sixb",
    "agent",
    "attachments",
    safePathSegment(messageId),
    `${safePathSegment(sandboxName)}-${safeFileName(fileName)}`
  )
}

function fileNameFor(fileRef: FileRef): string {
  const fromFileName = lastPathSegment(fileRef.fileName)
  if (fromFileName) return fromFileName
  const fromLogicalPath = lastPathSegment(fileRef.logicalPath)
  return fromLogicalPath || `${fileRef.blobId}.bin`
}

function lastPathSegment(value: string | undefined): string | undefined {
  const segment = value?.split(/[\\/]/).filter(Boolean).at(-1)?.trim()
  return segment || undefined
}

function safeFileName(value: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/]/g, "_")
    .replace(/^\.+$/, "_")
    .slice(0, 120)
  return cleaned || "attachment.bin"
}

function safePathSegment(value: string): string {
  return safeFileName(value).replace(/[^A-Za-z0-9._-]/g, "_") || "message"
}

function normalizedMediaType(value: string | undefined): string | undefined {
  const normalized = value?.split(";")[0]?.trim().toLowerCase()
  return normalized || undefined
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "application/yaml" ||
    mediaType === "application/x-yaml" ||
    mediaType === "application/javascript" ||
    mediaType === "application/typescript" ||
    mediaType === "application/csv"
  )
}

function looksLikeTextFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return [
    ".txt",
    ".md",
    ".markdown",
    ".json",
    ".jsonl",
    ".csv",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".yml",
    ".yaml",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".log",
  ].some((extension) => lower.endsWith(extension))
}

function hasImageHint(mediaType: string, fileName: string): boolean {
  return isImageMediaType(mediaType) || looksLikeImageFileName(fileName)
}

function isImageMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/")
}

function looksLikeImageFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].some((extension) =>
    lower.endsWith(extension)
  )
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
