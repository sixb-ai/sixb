import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { AgentToolResult } from "@sixb/core"
import {
  AGENT_FILE_MAX_BYTES,
  AGENT_TOOL_OUTPUTS_DIRECTORY,
  type AgentRunFileStore,
  type AgentToolCallFile,
  agentToolOutputPath,
  isAgentToolOutputFile,
  isAgentToolResult,
} from "@sixb/core/internal/agents"
import {
  assertJsonValue,
  type JsonValue,
  type ModelTool,
  type ModelToolExecutionContext,
  type ModelToolOutput,
} from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import { listSandboxFiles } from "../sandbox-files"
import { type AgentSandboxHandle, contextPath } from "../sandbox-handle"
import { BASH_TOOL_SPEC, keptCommandOutput } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import { AgentFileBudget } from "./tool-files"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"

/**
 * Past this, a tool's output reaches the model as a preview, and the whole of it as a file in the
 * sandbox that the agent reads in pieces or searches. Claude Code does the same from about 30 KB
 * (measured on its transcripts): one result then never takes more than a few KB of the context,
 * and nothing past a cap is lost.
 */
export const TOOL_OUTPUT_FILE_MIN_BYTES = 30 * 1024

/** Where saved outputs go, in the context directory: `$SIXB_TOOL_OUTPUTS_DIR`. */
export const TOOL_OUTPUTS_DIRECTORY = AGENT_TOOL_OUTPUTS_DIRECTORY

/**
 * The preview: the head, where a listing or a document starts, and the tail, where a command's
 * log ends with its errors and its verdict.
 */
const PREVIEW_HEAD_BYTES = 1_536
const PREVIEW_TAIL_BYTES = 512

/**
 * What one run may save, apart from the run's file budget that published artifacts and
 * file-returning tools take: saving gives way first, its outputs left to the copy their message
 * keeps. Identical outputs count once.
 */
export const TOOL_OUTPUTS_MAX_BYTES = 64 * 1024 * 1024

/**
 * What a run writes again of the outputs its history saved, newest first: a blank sandbox, or a
 * computer's, starts without them.
 */
const RESTORED_OUTPUTS_MAX_BYTES = 32 * 1024 * 1024

/** How many stored outputs a run reads at once to write them back. */
const RESTORED_OUTPUTS_CONCURRENCY = 4

/** Past this many files in the sandbox's directory, the rest are written back whether held. */
const LISTED_OUTPUTS_MAX_FILES = 1_000
const LIST_TIMEOUT_MS = 30_000

/** The readers: they page through files themselves, so their output is never saved to another. */
const FILE_READERS: ReadonlySet<string> = new Set([READ_TOOL_SPEC.name, VIEW_FILE_TOOL_SPEC.name])

const NOTICE_TAG = "tool_output_file"
const NOTICE_OPENING = new RegExp(`^<${NOTICE_TAG} sandboxPath="([^"]*)"`)

/** A saved output, between its call's execution and the preview the model reads of it. */
interface SavedCall {
  readonly file: AgentToolCallFile
  readonly sandboxPath: string
  contents?: string
}

/**
 * The run's tools, each saving an output too large for the context: stored as a file of its run,
 * like a tool's own files, and copied into the sandbox at `tool-outputs/<call id>-<digest>.txt`.
 * The model reads a preview with that path; the call's message part keeps a bounded copy of the
 * output and the stored file as its `outputFile` ({@link fileOf}), which every later run writes
 * back ({@link restoreSavedToolOutputs}). Saving that fails leaves the output as the part keeps it.
 */
export class ToolOutputFiles {
  readonly #saved = new Map<string, SavedCall>()
  readonly #budget: AgentFileBudget

  constructor(
    private readonly input: {
      readonly sandbox: () => Promise<AgentSandboxHandle>
      readonly blobStorage: Pick<AgentRunFileStore, "put">
      /** Test seam; production holds {@link TOOL_OUTPUTS_MAX_BYTES}, never the run's own budget. */
      readonly budget?: AgentFileBudget
    }
  ) {
    this.#budget = input.budget ?? new AgentFileBudget(TOOL_OUTPUTS_MAX_BYTES)
  }

  wrap(tools: readonly ModelTool[]): ModelTool[] {
    return tools.map((tool) => (FILE_READERS.has(tool.name) ? tool : this.saving(tool)))
  }

  /** The stored file of a call whose output was saved, for its message part. */
  fileOf(toolCallId: string): AgentToolCallFile | undefined {
    return this.#saved.get(toolCallId)?.file
  }

  private saving(tool: ModelTool): ModelTool {
    const project = (output: JsonValue, context: ModelToolExecutionContext) =>
      tool.toModelOutput ? tool.toModelOutput(output, context) : defaultModelOutput(output)

    return {
      ...tool,
      execute: async (input, context) => {
        const output = await tool.execute(input, context)
        const contents = savedOutputText(tool.name, output)
        if (contents === undefined) return output

        try {
          this.#saved.set(context.toolCallId, await this.save(tool.name, contents, context))
        } catch (error) {
          context.signal.throwIfAborted()
          console.warn(
            `[SixbAgent] Could not save a ${tool.name} output to a file, so the model reads what its message keeps:`,
            error
          )
        }
        return keptOutput(tool.name, output)
      },
      toModelOutput: async (output, context) => {
        const saved = this.#saved.get(context.toolCallId)
        if (saved?.contents === undefined) return project(output, context)

        const notice = toolOutputNotice({
          toolName: tool.name,
          output,
          path: saved.sandboxPath,
          contents: saved.contents,
        })
        saved.contents = undefined
        if (!isAgentToolResult(output)) return { type: "text", value: notice }

        // A file-aware result keeps its files, which its tool projects after the notice.
        const noticed: unknown = withText(output, notice)
        assertJsonValue(noticed)
        return project(noticed, context)
      },
    }
  }

  private async save(
    toolName: string,
    contents: string,
    context: ModelToolExecutionContext
  ): Promise<SavedCall> {
    const bytes = new TextEncoder().encode(contents)
    if (bytes.byteLength > AGENT_FILE_MAX_BYTES) {
      throw new Error(`the output exceeds the ${AGENT_FILE_MAX_BYTES}-byte file limit`)
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    this.#budget.holdContent(`sha256:${sha256}`, bytes.byteLength, toolName)

    try {
      const path = agentToolOutputPath(context.toolCallId, sha256)
      const fileRef = await this.input.blobStorage.put({
        body: bytes,
        expectedSizeBytes: bytes.byteLength,
        signal: context.signal,
        fileName: posix.basename(path),
        mediaType: "text/plain",
      })

      const handle = await this.input.sandbox()
      context.signal.throwIfAborted()
      const sandboxPath = posix.join(handle.contextDirectory, path)
      await handle.sandbox.writeFiles([
        { path: posix.resolve(handle.sandbox.workingDirectory, sandboxPath), contents: bytes },
      ])
      return { file: { fileRef, path }, sandboxPath, contents }
    } catch (error) {
      this.#budget.releaseContent(`sha256:${sha256}`)
      throw error
    }
  }
}

/**
 * The outputs a history saved, to write back: the newest within
 * {@link RESTORED_OUTPUTS_MAX_BYTES}, by the size they declare, listed oldest first so that a
 * later one at the same path is written last. Only a file of the shape the harness names is: the
 * stored messages are a runner's, or a fork's copy of them.
 */
export function savedToolOutputFiles(messages: readonly AgentMessageRecord[]): AgentToolCallFile[] {
  const files: AgentToolCallFile[] = []
  let bytes = 0

  newest: for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-call" || part.state !== "output-available") continue
      if (!isAgentToolOutputFile(part.outputFile)) continue

      bytes += part.outputFile.fileRef.sizeBytes
      if (bytes > RESTORED_OUTPUTS_MAX_BYTES) break newest
      files.push(part.outputFile)
    }
  }
  return files.reverse()
}

/**
 * Write the saved outputs back into a run's sandbox: those it does not hold already, as a
 * workspace that persists does, read from the store a few at a time, oldest first. A file is read
 * no further than the size it declares, so the bytes read stay within what
 * {@link savedToolOutputFiles} counted; one that cannot be read, or holds more, is left out.
 */
export async function restoreSavedToolOutputs(input: {
  readonly handle: AgentSandboxHandle
  readonly files: readonly AgentToolCallFile[]
  readonly blobStorage: Pick<AgentRunFileStore, "open">
  readonly signal: AbortSignal
}): Promise<void> {
  const { handle, signal } = input
  if (input.files.length === 0) return

  const directory = contextPath(handle, TOOL_OUTPUTS_DIRECTORY)
  const listing = await listSandboxFiles(handle, {
    directory,
    maxFiles: LISTED_OUTPUTS_MAX_FILES,
    signal,
    timeoutMs: LIST_TIMEOUT_MS,
  })
  const held = new Map(listing.files.map((file) => [file.relativePath, file.sizeBytes]))
  const missing = input.files.filter(
    (file) => held.get(posix.basename(file.path)) !== file.fileRef.sizeBytes
  )

  const read: (Uint8Array | undefined)[] = new Array(missing.length)
  let next = 0
  const reader = async () => {
    while (next < missing.length) {
      const index = next++
      const file = missing[index]
      if (file) read[index] = await readSavedFile(input.blobStorage, file, signal)
    }
  }
  await Promise.all(Array.from({ length: RESTORED_OUTPUTS_CONCURRENCY }, reader))

  signal.throwIfAborted()
  const records = missing.flatMap((file, index) => {
    const contents = read[index]
    return contents ? [{ path: posix.join(directory, posix.basename(file.path)), contents }] : []
  })
  if (records.length > 0) await handle.sandbox.writeFiles(records)
}

/** A stored output's bytes, read no further than its declared size; undefined when it differs. */
async function readSavedFile(
  blobStorage: Pick<AgentRunFileStore, "open">,
  file: AgentToolCallFile,
  signal: AbortSignal
): Promise<Uint8Array | undefined> {
  const maxBytes = file.fileRef.sizeBytes
  try {
    const reader = (await blobStorage.open(file.fileRef.blobId)).getReader()
    const bytes = new Uint8Array(maxBytes)
    let length = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        if (length + value.byteLength > maxBytes) {
          throw new Error(`it holds more than the ${maxBytes} bytes it declares`)
        }
        bytes.set(value, length)
        length += value.byteLength
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if (length !== maxBytes) throw new Error(`it holds ${length} bytes, not ${maxBytes}`)
    return bytes
  } catch (error) {
    signal.throwIfAborted()
    console.warn(`[SixbAgent] Could not write back the saved tool output ${file.path}:`, error)
    return undefined
  }
}

/** The path a tool result's text names when it is the preview of a saved output. */
export function savedToolOutputPath(text: string): string | undefined {
  return NOTICE_OPENING.exec(text)?.[1]
}

/** The file an output too large for the context is saved to, or undefined when it fits. */
function savedOutputText(toolName: string, output: JsonValue): string | undefined {
  if (modelFacingBytes(output) <= TOOL_OUTPUT_FILE_MIN_BYTES) return undefined

  const text = outputText(toolName, output)
  return text.endsWith("\n") ? text : `${text}\n`
}

/**
 * What the message part keeps of a saved output: a command's streams bounded, as the app shows
 * them. Any other tool's output is its author's contract, saved and streamed as it returned it.
 */
function keptOutput(toolName: string, output: JsonValue): JsonValue {
  if (toolName !== BASH_TOOL_SPEC.name || !isCommandOutput(output)) return output

  const kept: unknown = keptCommandOutput(output)
  assertJsonValue(kept)
  return kept
}

/**
 * What the model would read of an output: a file-aware result's text (its files reach the model
 * on their own), a string, or the JSON it prints.
 */
function modelFacingBytes(output: JsonValue): number {
  if (isAgentToolResult(output)) return utf8Bytes(resultText(output))
  if (typeof output === "string") return utf8Bytes(output)
  return utf8Bytes(JSON.stringify(output))
}

/**
 * An output as a file the agent reads by lines and searches: a command's streams as it printed
 * them, text as is, JSON indented. Compact JSON is indented, or one long line would be all the
 * read tool sees of it.
 */
function outputText(toolName: string, output: JsonValue): string {
  if (toolName === BASH_TOOL_SPEC.name && isCommandOutput(output)) {
    const stdout = indentedJsonText(output.stdout)
    return output.stderr ? `${stdout}\n--- stderr ---\n${output.stderr}` : stdout
  }
  if (isAgentToolResult(output)) return indentedJsonText(resultText(output))
  if (typeof output === "string") return indentedJsonText(output)

  return JSON.stringify(output, null, 2)
}

/**
 * What the model reads in place of an output saved to a file: where it is, how large, how to read
 * it, and a preview.
 */
function toolOutputNotice(input: {
  readonly toolName: string
  readonly output: JsonValue
  readonly path: string
  readonly contents: string
}): string {
  const bytes = Buffer.from(input.contents)
  const headEnd = previewHeadEnd(bytes, PREVIEW_HEAD_BYTES)
  const tailStart = previewTailStart(bytes, PREVIEW_TAIL_BYTES)
  // The file ends with a newline, which the closing tag's own line stands for.
  const tail =
    tailStart > headEnd ? bytes.subarray(tailStart).toString("utf8").replace(/\n$/, "") : undefined
  const exit =
    input.toolName === BASH_TOOL_SPEC.name && isCommandOutput(input.output)
      ? [`Exit code: ${input.output.exitCode}${input.output.timedOut ? " (timed out)" : ""}.`]
      : []
  const lines = input.contents.split("\n").length - 1

  return [
    `<${NOTICE_TAG} sandboxPath="${input.path}" sizeBytes="${bytes.byteLength}" lines="${lines}">`,
    "This output is too large for the context: the whole of it is in this file. Read it in pieces with the read tool (offset, limit), or search it with grep.",
    ...exit,
    "",
    `First ${headEnd.toLocaleString("en-US")} bytes:`,
    bytes.subarray(0, headEnd).toString("utf8"),
    ...(tail === undefined
      ? []
      : [
          `[… ${(tailStart - headEnd).toLocaleString("en-US")} bytes …]`,
          `Last ${(bytes.byteLength - tailStart).toLocaleString("en-US")} bytes:`,
          tail,
        ]),
    `</${NOTICE_TAG}>`,
  ].join("\n")
}

/** Where the first `maxBytes` end, at a line's end when one is in their second half. */
function previewHeadEnd(bytes: Buffer, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return bytes.byteLength

  let end = maxBytes
  // Never inside a character: back to the start of the one the cut falls in.
  while (end > 0 && isContinuationByte(bytes[end])) end -= 1
  const newline = bytes.lastIndexOf(10, end - 1)
  return newline > end / 2 ? newline : end
}

/** Where the last `maxBytes` start, at a line's start when one is in their first half. */
function previewTailStart(bytes: Buffer, maxBytes: number): number {
  if (bytes.byteLength <= maxBytes) return 0

  let start = bytes.byteLength - maxBytes
  while (start < bytes.byteLength && isContinuationByte(bytes[start])) start += 1
  const newline = bytes.indexOf(10, start)
  return newline !== -1 && newline < start + maxBytes / 2 ? newline + 1 : start
}

function isContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

function defaultModelOutput(output: JsonValue): ModelToolOutput {
  return typeof output === "string"
    ? { type: "text", value: output }
    : { type: "json", value: output }
}

/** A file-aware result with its text replaced by `text`, its files kept. */
function withText(output: AgentToolResult, text: string): AgentToolResult {
  return {
    kind: "agentToolResult",
    content: [{ type: "text", text }, ...output.content.filter((part) => part.type === "file")],
  }
}

function resultText(output: AgentToolResult): string {
  return output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

/**
 * A compact JSON document indented, else the text as it is. Only one that prints back as it came:
 * an integer past 2^53 or an escape would otherwise read another value or other bytes in the file.
 */
function indentedJsonText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return text
  }
  return JSON.stringify(value) === trimmed ? JSON.stringify(value, null, 2) : text
}

interface CommandOutput {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut?: boolean
}

function isCommandOutput(output: JsonValue): output is JsonValue & CommandOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    typeof output.exitCode === "number" &&
    typeof output.stdout === "string" &&
    typeof output.stderr === "string" &&
    typeof output.durationMs === "number"
  )
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}
