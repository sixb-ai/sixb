import { AgentToolPublicError, type AgentToolResult } from "@sixb/core"
import { isAgentToolResult } from "@sixb/core/internal/agents"
import { assertJsonValue, type JsonObject, type JsonValue, type ModelTool } from "@sixb/core/models"
import type { BackgroundCommandOutput, BackgroundCommands } from "../background-commands"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"
import type { WaitForSubagentsOutput } from "../subagent-tools"

/** The longest `wait` waits for a command to end. */
const MAX_WAIT_MS = 600_000

/** How many ids one `wait` takes. */
const MAX_WAIT_IDS = 16

/** Before `wait` and `stop`, a background command's tools: earlier threads hold calls to them. */
export const LEGACY_BACKGROUND_TOOLS = ["bash_output", "bash_stop"] as const

/** Before `wait`, the Agent's wait for its children: earlier threads hold calls to it. */
export const LEGACY_WAIT_AGENT_TOOL = "wait_agent"

export const WAIT_TOOL_SPEC = {
  name: "wait",
  strict: true,
  description: [
    "Wait for work you started: background commands, by the id bash returned, and child agents, by their key.",
    "A command returns its status (running, exited with its code, or stopped) and its output since your last read: the newest 20,000 bytes, the rest in its file. To see a running command's output without waiting, read its file.",
    "A child returns its final text or failure, and the files it wrote to out/, each with its path in your sandbox.",
    "It returns once all have ended, or as soon as a child asks you a question, or once timeoutMs passes for commands. You are told when a command ends: do not poll.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        minItems: 1,
        maxItems: MAX_WAIT_IDS,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
        description: "Background command ids, like bg_3f9a1c, and child agents' keys.",
      },
      timeoutMs: {
        type: "number",
        description: `The longest to wait for commands to end, up to ${MAX_WAIT_MS}; 0 returns their status at once. Default: ${MAX_WAIT_MS}.`,
      },
    },
    required: ["ids"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export const STOP_TOOL_SPEC = {
  name: "stop",
  strict: true,
  description:
    "Stop work you started: a background command and all it started (SIGTERM, then SIGKILL after 3 s), or a child agent of this turn. Returns what wait would: how it ended, and its output or answer so far.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        minLength: 1,
        description: "A background command's id, like bg_3f9a1c, or a child agent's key.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

/**
 * The Agent's children, as `wait` and `stop` reach them: an id that names no background command
 * names one of them, by its key or its run id.
 */
export interface WaitableChildren {
  wait(ids: readonly string[], signal: AbortSignal): Promise<WaitForSubagentsOutput>
  stop(id: string, signal: AbortSignal): Promise<WaitForSubagentsOutput>
}

/** What `wait` and `stop` return: the commands named, and the children's results. */
export interface WaitOutput extends Partial<Omit<WaitForSubagentsOutput, "files">> {
  readonly commands?: readonly BackgroundCommandOutput[]
}

interface WaitToolInput {
  readonly ids: readonly string[]
  readonly timeoutMs?: number
}

interface StopToolInput {
  readonly id: string
}

/** `wait`: until the commands and children named end, a child asks, or the timeout passes. */
export function createWaitTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  commands: BackgroundCommands,
  children?: WaitableChildren
): ModelTool<WaitToolInput> {
  return {
    ...WAIT_TOOL_SPEC,
    parseInput: (value) => {
      const input = parseObject(WAIT_TOOL_SPEC.name, value, ["ids", "timeoutMs"])
      const ids = input.ids
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > MAX_WAIT_IDS ||
        !ids.every((id) => typeof id === "string" && id.trim().length > 0)
      ) {
        throw publicError(
          WAIT_TOOL_SPEC.name,
          `ids must list 1 to ${MAX_WAIT_IDS} background command ids or child agents' keys.`
        )
      }
      const timeoutMs = input.timeoutMs
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs < 0)) {
        throw publicError(WAIT_TOOL_SPEC.name, "timeoutMs must be a number of milliseconds.")
      }
      return {
        ids: [...new Set(ids.map((id: string) => id.trim()))],
        ...(timeoutMs === undefined ? {} : { timeoutMs: Math.min(timeoutMs, MAX_WAIT_MS) }),
      }
    },
    async execute(input, { signal }): Promise<JsonValue> {
      const commandIds = input.ids.filter((id) => commands.has(id))
      const childIds = input.ids.filter((id) => !commands.has(id))
      if (childIds.length > 0 && !children) throw unknownCommand(WAIT_TOOL_SPEC.name, childIds)
      const timeoutMs = input.timeoutMs ?? MAX_WAIT_MS

      // The children decide when a wait for them returns, at their end or a question: then the
      // commands are read as they are. Commands that end first wait for the children.
      const settled = new AbortController()
      const stopWaiting = () => settled.abort()
      signal.addEventListener("abort", stopWaiting, { once: true })
      try {
        const commandsEnded = Promise.all(
          commandIds.map((id) => commands.wait(id, timeoutMs, settled.signal))
        ).catch((error: unknown) => {
          if (!settled.signal.aborted || signal.aborted) throw error
        })
        const childrenWaited =
          children && childIds.length > 0
            ? children.wait(childIds, signal).finally(stopWaiting)
            : undefined
        // Awaited together: the turn's stop rejects both, and one wait for both handles each.
        const [waited] = await Promise.all([childrenWaited, commandsEnded])
        signal.throwIfAborted()
        return await output(
          await readCommands(commandIds, commands, resolveSandbox, signal),
          waited
        )
      } finally {
        signal.removeEventListener("abort", stopWaiting)
      }
    },
    toModelOutput: textOfResult,
    errorText: agentToolErrorText,
  }
}

/** `stop`: stop a command or a child, then report how it ended and its output or answer so far. */
export function createStopTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  commands: BackgroundCommands,
  children?: WaitableChildren
): ModelTool<StopToolInput> {
  return {
    ...STOP_TOOL_SPEC,
    parseInput: (value) => {
      const input = parseObject(STOP_TOOL_SPEC.name, value, ["id"])
      if (typeof input.id !== "string" || !input.id.trim()) {
        throw publicError(
          STOP_TOOL_SPEC.name,
          "id must be a background command's id, such as bg_3f9a1c, or a child agent's key."
        )
      }
      return { id: input.id.trim() }
    },
    async execute(input, { signal }): Promise<JsonValue> {
      if (commands.has(input.id)) {
        await commands.stop(input.id)
        return output(await readCommands([input.id], commands, resolveSandbox, signal), undefined)
      }
      if (!children) throw unknownCommand(STOP_TOOL_SPEC.name, [input.id])
      return output([], await children.stop(input.id, signal))
    },
    toModelOutput: textOfResult,
    errorText: agentToolErrorText,
  }
}

/**
 * The background commands a tool's result reports, as each read it: `bash` and the tools before
 * `wait` report one, `wait` and `stop` those they name.
 */
export function reportedCommands(toolName: string, output: unknown): readonly unknown[] {
  if (toolName === "bash" || (LEGACY_BACKGROUND_TOOLS as readonly string[]).includes(toolName)) {
    return [output]
  }
  if (toolName !== WAIT_TOOL_SPEC.name && toolName !== STOP_TOOL_SPEC.name) return []
  const value = resultValue(output)
  return isRecord(value) && Array.isArray(value.commands) ? value.commands : []
}

async function readCommands(
  ids: readonly string[],
  commands: BackgroundCommands,
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  signal: AbortSignal
): Promise<readonly BackgroundCommandOutput[]> {
  if (ids.length === 0) return []
  const sandbox = await resolveSandbox()
  return Promise.all(ids.map((id) => commands.read(id, sandbox, signal)))
}

/**
 * The commands alone are a plain result. With children it is a rich one, so the files they wrote
 * reach later turns through `$SIXB_ATTACHMENTS` and the work trace.
 */
async function output(
  read: readonly BackgroundCommandOutput[],
  waited: WaitForSubagentsOutput | undefined
): Promise<JsonValue> {
  const commandsPart = read.length > 0 ? { commands: read } : {}
  if (!waited) {
    const result: WaitOutput = commandsPart
    assertJsonValue(result)
    return result
  }
  const { files, ...answer } = waited
  const result: AgentToolResult = {
    kind: "agentToolResult",
    content: [
      { type: "text", text: JSON.stringify({ ...commandsPart, ...answer } satisfies WaitOutput) },
      ...files.map(({ fileRef }) => ({ type: "file" as const, fileRef })),
    ],
  }
  assertJsonValue(result)
  return result
}

/** The answer lists each file's path this turn; the Agent reads the ones it needs. */
function textOfResult(output: JsonValue) {
  return isAgentToolResult(output)
    ? {
        type: "text" as const,
        value: output.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
      }
    : { type: "json" as const, value: output }
}

/** A result's value: a rich one's first text, parsed. */
function resultValue(output: unknown): unknown {
  if (!isAgentToolResult(output)) return output
  const text = output.content.find((part) => part.type === "text")
  if (text?.type !== "text") return undefined
  try {
    return JSON.parse(text.text)
  } catch {
    return undefined
  }
}

function unknownCommand(tool: string, ids: readonly string[]): AgentToolPublicError {
  return publicError(
    tool,
    `has no background command ${ids.map((id) => `'${id}'`).join(", ")}: pass the id bash returned, such as bg_3f9a1c.`
  )
}

function parseObject(tool: string, value: unknown, keys: readonly string[]) {
  if (!isRecord(value)) throw publicError(tool, "input must be an object.")
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw publicError(tool, `input contains unknown property '${key}'.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function publicError(tool: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] ${tool} ${message}`)
}
