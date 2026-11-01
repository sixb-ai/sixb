import { createHash } from "node:crypto"
import { posix } from "node:path"
import type { AgentToolResult } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import {
  assertJsonValue,
  type JsonValue,
  type ModelTool,
  type ModelToolExecutionContext,
  type ModelToolOutput,
} from "@sixb/core/models"
import type { AgentMessageRecord } from "@sixb/core/storage"
import type { AgentSandboxHandle } from "../sandbox-handle"
import { BASH_TOOL_SPEC } from "./bash"
import { READ_TOOL_SPEC } from "./read"
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

/** A saved output: its path as the agent names it, and its text. */
export interface SavedToolOutput {
  readonly path: string
  readonly contents: string
}

/**
 * The run's tools, each saving an output too large for the context to a file in the sandbox and
 * giving the model a preview with its path instead. The stored output stays whole, and what the
 * model read is stored beside it as the call's `modelOutput`: later turns replay those bytes, and
 * write the file again from the output ({@link replayedToolOutputs}).
 */
export function withToolOutputFiles(
  tools: readonly ModelTool[],
  sandbox: () => Promise<AgentSandboxHandle>
): ModelTool[] {
  return tools.map((tool) => (FILE_READERS.has(tool.name) ? tool : savingOutput(tool, sandbox)))
}

function savingOutput(tool: ModelTool, sandbox: () => Promise<AgentSandboxHandle>): ModelTool {
  const project = (output: JsonValue, context: ModelToolExecutionContext) =>
    tool.toModelOutput ? tool.toModelOutput(output, context) : defaultModelOutput(output)

  return {
    ...tool,
    async toModelOutput(output, context) {
      const contents = savedOutputText(tool.name, output)
      if (contents === undefined) return project(output, context)

      let path: string
      try {
        const handle = await sandbox()
        context.signal.throwIfAborted()
        path = toolOutputPath(handle.contextDirectory, context.toolCallId)
        await handle.sandbox.writeFiles([
          { path: posix.resolve(handle.sandbox.workingDirectory, path), contents },
        ])
      } catch (error) {
        context.signal.throwIfAborted()
        // Losing the output would be worse than a large result: the context guard cuts it if needed.
        console.warn(
          `[SixbAgent] Could not save a ${tool.name} output to a file, so the model reads it whole:`,
          error
        )
        return project(output, context)
      }

      const notice = toolOutputNotice({ toolName: tool.name, output, path, contents })
      if (!isAgentToolResult(output)) return { type: "text", value: notice }

      // A file-aware result keeps its files, which its tool projects after the notice.
      const noticed: unknown = withText(output, notice)
      assertJsonValue(noticed)
      return project(noticed, context)
    },
  }
}

/**
 * The outputs a history saved, to write again where their notices named them, newest first
 * within {@link REPLAYED_OUTPUTS_MAX_BYTES}. Each file is derived from the stored output as the
 * call derived it, and only where the stored notice names that very file.
 */
export function replayedToolOutputs(
  messages: readonly AgentMessageRecord[],
  contextDirectory: string
): SavedToolOutput[] {
  const saved: SavedToolOutput[] = []
  let bytes = 0

  for (const message of [...messages].reverse()) {
    for (const part of [...message.parts].reverse()) {
      if (part.type !== "tool-call" || part.state !== "output-available") continue
      const read = part.modelOutput?.type === "text" ? part.modelOutput.value : ""
      if (!read.startsWith(`<${NOTICE_TAG} `)) continue

      const contents = savedOutputText(part.toolName, part.output)
      if (contents === undefined) continue
      const path = toolOutputPath(contextDirectory, part.toolCallId)
      if (!read.startsWith(noticeOpening(path, contents))) continue

      bytes += utf8Bytes(contents)
      if (bytes > REPLAYED_OUTPUTS_MAX_BYTES) return saved
      saved.push({ path, contents })
    }
  }
  return saved
}

/** Where a call's output is saved, as the agent names it: one file per call, by its id. */
export function toolOutputPath(contextDirectory: string, toolCallId: string): string {
  const name = /^[A-Za-z0-9_-]{1,128}$/.test(toolCallId)
    ? toolCallId
    : createHash("sha256").update(toolCallId).digest("hex").slice(0, 16)
  return posix.join(contextDirectory, TOOL_OUTPUTS_DIRECTORY, `${name}.txt`)
}

/** The file an output too large for the context is saved to, or undefined when it fits. */
function savedOutputText(toolName: string, output: JsonValue): string | undefined {
  if (modelFacingBytes(output) <= TOOL_OUTPUT_FILE_MIN_BYTES) return undefined

  const text = outputText(toolName, output)
  return text.endsWith("\n") ? text : `${text}\n`
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

  // Sorted, so the file a later run writes from a `jsonb` copy holds the same bytes.
  return JSON.stringify(output, (_key, value: unknown) => sortedKeys(value), 2)
}

/**
 * What the model reads in place of an output saved to a file: where it is, how large, how to read
 * it, and a preview. Derived from the call alone: a later run that writes the file again finds the
 * same opening.
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

  return [
    noticeOpening(input.path, input.contents),
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

function noticeOpening(path: string, contents: string): string {
  const lines = contents.split("\n").length - 1
  return `<${NOTICE_TAG} sandboxPath="${path}" sizeBytes="${utf8Bytes(contents)}" lines="${lines}">`
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
  readonly timedOut?: boolean
}

function isCommandOutput(output: JsonValue): output is JsonValue & CommandOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    typeof output.exitCode === "number" &&
    typeof output.stdout === "string" &&
    typeof output.stderr === "string"
  )
}

function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value

  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) sorted[key] = record[key]
  return sorted
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8")
}
