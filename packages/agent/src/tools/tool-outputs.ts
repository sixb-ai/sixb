import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { AgentToolResult } from "@sixb/core"
import {
  AGENT_FILE_MAX_BYTES,
  type AgentRunFileStore,
  type AgentToolCallFile,
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
import type { AgentSandboxHandle } from "../sandbox-handle"
import { BASH_TOOL_SPEC, keptCommandOutput } from "./bash"
import { READ_TOOL_SPEC } from "./read"
import type { AgentFileBudget } from "./tool-files"
import { VIEW_FILE_TOOL_SPEC } from "./view-file"

/**
 * Past this, a tool's output reaches the model as a preview, and the whole of it as a file in the
 * sandbox that the agent reads in pieces or searches. Claude Code does the same from about 30 KB
 * (measured on its transcripts): one result then never takes more than a few KB of the context,
 * and nothing past a cap is lost.
 */
export const TOOL_OUTPUT_FILE_MIN_BYTES = 30 * 1024

/** Where saved outputs go, in the context directory: `$SIXB_TOOL_OUTPUTS_DIR`. */
export const TOOL_OUTPUTS_DIRECTORY = "tool-outputs"

/**
 * The preview: the head, where a listing or a document starts, and the tail, where a command's
 * log ends with its errors and its verdict.
 */
const PREVIEW_HEAD_BYTES = 1_536
const PREVIEW_TAIL_BYTES = 512

/**
 * What a run writes again of the outputs its history saved, newest first: a blank sandbox, or a
 * computer's, starts without them.
 */
const REPLAYED_OUTPUTS_MAX_BYTES = 32 * 1024 * 1024

/** The readers: they page through files themselves, so their output is never saved to another. */
const FILE_READERS: ReadonlySet<string> = new Set([READ_TOOL_SPEC.name, VIEW_FILE_TOOL_SPEC.name])

const NOTICE_TAG = "tool_output_file"
const NOTICE_OPENING = new RegExp(`^<${NOTICE_TAG} sandboxPath="([^"]*)"`)

/** An output a history saved, to write again: its path as the agent names it, and its bytes. */
export interface SavedToolOutput {
  readonly path: string
  readonly contents: Uint8Array
}

/** A saved output, between its call's execution and the preview the model reads of it. */
interface SavedCall {
  readonly file: AgentToolCallFile
  readonly sandboxPath: string
  contents?: string
}

/**
 * The run's tools, each saving an output too large for the context: stored as a file of its run,
 * like a tool's own files, and copied into the sandbox at `tool-outputs/<call id>.txt`. The model
 * reads a preview with that path; the call's message part keeps a bounded copy of the output and
 * the stored file as its `outputFile` ({@link fileOf}), which every later run copies back
 * ({@link readSavedToolOutputs}). Saving that fails leaves the output as the part keeps it.
 */
export class ToolOutputFiles {
  readonly #saved = new Map<string, SavedCall>()

  constructor(
    private readonly input: {
      readonly sandbox: () => Promise<AgentSandboxHandle>
      readonly blobStorage: Pick<AgentRunFileStore, "put">
      /** Shared with every other file the run stores. */
      readonly budget: AgentFileBudget
    }
  ) {}

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
    const reservation = this.input.budget.reserve(bytes.byteLength, toolName)

    try {
      const path = toolOutputPath(context.toolCallId)
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
      reservation.release()
      throw error
    }
  }
}

/**
 * The outputs a history saved, read from their stored files to write again where their previews
 * named them, newest first within {@link REPLAYED_OUTPUTS_MAX_BYTES}. One whose file cannot be
 * read is left out: the message keeps a bounded copy of it.
 */
export async function readSavedToolOutputs(input: {
  readonly messages: readonly AgentMessageRecord[]
  readonly contextDirectory: string
  readonly blobStorage: Pick<AgentRunFileStore, "open">
  readonly signal?: AbortSignal
}): Promise<SavedToolOutput[]> {
  const files: AgentToolCallFile[] = []
  let bytes = 0

  newest: for (const message of [...input.messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-call" || part.state !== "output-available") continue
      if (!part.outputFile) continue

      bytes += part.outputFile.fileRef.sizeBytes
      if (bytes > REPLAYED_OUTPUTS_MAX_BYTES) break newest
      files.push(part.outputFile)
    }
  }

  const read = await Promise.all(
    files.map(async (file): Promise<SavedToolOutput | undefined> => {
      input.signal?.throwIfAborted()
      try {
        const stream = await input.blobStorage.open(file.fileRef.blobId)
        const contents = new Uint8Array(await new Response(stream).arrayBuffer())
        return { path: posix.join(input.contextDirectory, file.path), contents }
      } catch (error) {
        input.signal?.throwIfAborted()
        console.warn(`[SixbAgent] Could not read the saved tool output ${file.path}:`, error)
        return undefined
      }
    })
  )
  return read.filter((output) => output !== undefined)
}

/** The path a tool result's text names when it is the preview of a saved output. */
export function savedToolOutputPath(text: string): string | undefined {
  return NOTICE_OPENING.exec(text)?.[1]
}

/** Where a call's output is saved, relative to the context directory: one file per call. */
function toolOutputPath(toolCallId: string): string {
  const name = /^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)
    ? toolCallId
    : createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)
  return posix.join(TOOL_OUTPUTS_DIRECTORY, `${name}.txt`)
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
