import { posix } from "node:path"
import type {
  AgentFileDataProjection,
  AgentMessagePart,
  BlobInfo,
  BlobStorage,
  FileRef,
} from "@sixb/core"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { type LanguageModel, resolveModelCapabilities } from "@sixb/llm"
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
}

interface AttachmentWorkItem {
  readonly message: AgentMessageRecord
  readonly part: Extract<AgentMessagePart, { type: "file" }>
  readonly partIndex: number
}

export async function prepareAgentAttachments(input: {
  readonly projectId: string
  readonly threadId: string
  readonly messages: readonly AgentMessageRecord[]
  readonly blobStorage: BlobStorage
  readonly apiBaseUrl: string
  readonly inlineImages: boolean
}): Promise<PreparedAgentAttachmentContext> {
  const promptTextByPartKey = new Map<string, string>()
  const modelFileDataByPartKey = new Map<string, AgentFileDataProjection>()
  const sandboxFiles: PreparedSandboxAttachmentFile[] = []
  const entries: PreparedAgentAttachment[] = []
  let sandboxBytes = 0
  let textInlineBytes = 0

  for (const item of fileWorkItems(input.messages)) {
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

function fileWorkItems(messages: readonly AgentMessageRecord[]): AttachmentWorkItem[] {
  const items: AttachmentWorkItem[] = []
  for (const message of messages) {
    message.parts.forEach((part, partIndex) => {
      if (part.type === "file") {
        items.push({ message, part, partIndex })
      }
    })
  }
  const retainedAssistantKeys = new Set(
    items
      .filter((item) => item.message.role === "assistant")
      .slice(-MAX_ASSISTANT_ATTACHMENTS)
      .map((item) => attachmentKey(item.message.id, item.partIndex))
  )
  return items.filter(
    (item) =>
      item.message.role !== "assistant" ||
      retainedAssistantKeys.has(attachmentKey(item.message.id, item.partIndex))
  )
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
}): Promise<{
  readonly entry: PreparedAgentAttachment
  readonly promptText: string
  readonly modelFileData?: AgentFileDataProjection
  readonly sandboxFile?: PreparedSandboxAttachmentFile
  readonly sandboxBytesAdded: number
  readonly textInlineBytesAdded: number
}> {
  const { item } = input
  const key = attachmentKey(item.message.id, item.partIndex)
  const fileRef = item.part.fileRef
  const fileName = fileNameFor(fileRef)
  const mediaType = normalizedMediaType(fileRef.mediaType) ?? "application/octet-stream"
  const contentPath = `/parts/${item.partIndex}/fileRef`
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

  const stat = await safeBlobStat(input.blobStorage, fileRef, notes)
  if (!stat) {
    inlineDisposition = "omitted"
    notes.push("[File omitted: blob content is not available or no longer matches this FileRef.]")
  } else {
    const canMaterializeFile = stat.sizeBytes <= DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxFileMaxBytes
    const canMaterializeTotal =
      input.sandboxBytes + stat.sizeBytes <= DEFAULT_AGENT_ATTACHMENT_LIMITS.sandboxTotalMaxBytes
    const mayInlineContent = item.message.role !== "assistant"
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
      const read = await readBlobBytes(input.blobStorage, fileRef.blobId, readLimit)
      if (read.ok) {
        bytes = read.bytes
      } else if (read.reason === "too_large") {
        notes.push("[File not read inline: file exceeds the attachment read limit.]")
      } else {
        notes.push(`[File not read inline: ${read.reason}.]`)
      }
    }

    if (bytes && needsFullBytes && bytes.byteLength === stat.sizeBytes) {
      sandboxPath = sandboxAttachmentPath(item.message.id, item.partIndex, fileName)
      sandboxFile = { key, path: sandboxPath, bytes }
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
        item.message.role === "assistant"
          ? "[Generated file kept as metadata: use the sandbox path or content URL when its contents are needed.]"
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
  notes: string[]
): Promise<BlobInfo | null> {
  let stat: BlobInfo | null
  try {
    stat = await blobStorage.stat(fileRef.blobId)
  } catch (error) {
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
  maxBytes: number
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string }
> {
  let stream: ReadableStream<Uint8Array>
  try {
    stream = await blobStorage.open(blobId)
  } catch (error) {
    console.error("[SixbAgentWorker] Failed to open an attachment blob.", error)
    return { ok: false, reason: "blob content is unavailable" }
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: "too_large" }
      }
      chunks.push(value)
    }
  } finally {
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

  const image = await processAgentImageAttachment({
    bytes: input.bytes,
    declaredMediaType: input.mediaType,
    fileName: input.fileName,
    limits: DEFAULT_AGENT_ATTACHMENT_LIMITS,
  })
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

export async function modelSupportsInlineImages(model: LanguageModel): Promise<boolean> {
  try {
    const mediaTypes = (await resolveModelCapabilities(model)).inputMediaTypes
    return mediaTypes === "any" || mediaTypes?.some(mediaPatternMatchesImages) === true
  } catch {
    return false
  }
}

function mediaPatternMatchesImages(pattern: string): boolean {
  const normalized = pattern.toLowerCase()
  return (
    normalized === "*/*" ||
    normalized === "image" ||
    normalized === "image/*" ||
    normalized.startsWith("image/")
  )
}

export function attachmentKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`
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

function sandboxAttachmentPath(messageId: string, partIndex: number, fileName: string): string {
  return posix.join(
    ".sixb",
    "agent",
    "attachments",
    safePathSegment(messageId),
    `${partIndex}-${safeFileName(fileName)}`
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
