import type { FileRef } from "@sixb/core"
import { isFileRef } from "@sixb/core"
import type { WorkflowIOSnapshot } from "@sixb/core/internal/workflows"
import type { PreparedAgentAttachmentContext } from "./attachments"
import type { AgentWorkerContext } from "./types"

const MAX_WORKFLOW_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_WORKFLOW_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024

/** Materialize nested FileRefs from a workflow input into the headless task sandbox. */
export async function prepareWorkflowInputAttachments(input: {
  readonly input: WorkflowIOSnapshot
  readonly blobStorage: AgentWorkerContext["blobStorage"]
}): Promise<PreparedAgentAttachmentContext> {
  const refs: Array<{ readonly path: string; readonly fileRef: FileRef }> = []
  collectFileRefs(input.input, "input", refs)
  const sandboxFiles: PreparedAgentAttachmentContext["sandboxFiles"] extends readonly (infer T)[]
    ? T[]
    : never = []
  const manifest: Array<Record<string, unknown>> = []
  let totalBytes = 0

  for (const [index, item] of refs.entries()) {
    const stat = await input.blobStorage.stat(item.fileRef.blobId)
    if (
      !stat ||
      stat.digest !== item.fileRef.digest ||
      stat.sizeBytes !== item.fileRef.sizeBytes ||
      stat.sizeBytes > MAX_WORKFLOW_ATTACHMENT_BYTES ||
      totalBytes + stat.sizeBytes > MAX_WORKFLOW_ATTACHMENTS_TOTAL_BYTES
    ) {
      manifest.push({ path: item.path, fileRef: item.fileRef, materialized: false })
      continue
    }

    const bytes = await readAllBytes(
      await input.blobStorage.open(item.fileRef.blobId),
      stat.sizeBytes
    )
    const fileName = safeFileName(item.fileRef.fileName ?? `${item.fileRef.blobId}.bin`)
    const sandboxPath = `.sixb/agent/attachments/workflow-input/${index}-${fileName}`
    sandboxFiles.push({ key: item.path, path: sandboxPath, bytes })
    totalBytes += bytes.byteLength
    manifest.push({
      path: item.path,
      fileRef: item.fileRef,
      materialized: true,
      sandboxPath,
    })
  }

  return {
    entries: [],
    promptTextByPartKey: new Map(),
    modelFileDataByPartKey: new Map(),
    sandboxFiles,
    manifestJson: JSON.stringify({ attachments: manifest }, null, 2),
  }
}

function collectFileRefs(
  value: unknown,
  path: string,
  output: Array<{ readonly path: string; readonly fileRef: FileRef }>
): void {
  if (isFileRef(value)) {
    output.push({ path, fileRef: value })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectFileRefs(entry, `${path}[${index}]`, output)
    })
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      collectFileRefs(entry, `${path}.${key}`, output)
    }
  }
}

async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number
): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedSize)
  const reader = stream.getReader()
  let offset = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > expectedSize) {
        throw new Error("Blob size changed while reading.")
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== expectedSize) throw new Error("Blob size changed while reading.")
  return bytes
}

function safeFileName(value: string): string {
  const name = value
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[^A-Za-z0-9._-]/g, "_")
  return name || "attachment.bin"
}
