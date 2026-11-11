import { AgentToolPublicError } from "@sixb/core"
import type { JsonObject, JsonValue, ModelTool } from "@sixb/core/models"
import type { BackgroundCommandOutput, BackgroundCommands } from "../background-commands"
import { agentToolErrorText } from "../model-adapters"
import type { AgentSandboxHandle } from "../sandbox-handle"

/** The longest `bash_output` waits for a command to end. */
const MAX_WAIT_MS = 600_000

export const BASH_OUTPUT_TOOL_SPEC = {
  name: "bash_output",
  strict: true,
  description:
    "A background command's status (running, exited with its code, or stopped) and its output since your last read: the newest 20,000 bytes, the rest in its file. wait blocks until it ends, at most that many ms. You are told when one ends: do not poll.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id bash returned, like bg_3f9a1c." },
      wait: {
        type: "number",
        description: "Milliseconds to wait for its end, up to 600000.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

export const BASH_STOP_TOOL_SPEC = {
  name: "bash_stop",
  strict: true,
  description:
    "Stop a background command and all it started: SIGTERM, then SIGKILL after 3 s. Returns its final status and output since your last read.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The id bash returned, like bg_3f9a1c." },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JsonObject,
} as const

interface BashOutputToolInput {
  readonly id: string
  readonly wait?: number
}

interface BashStopToolInput {
  readonly id: string
}

/** `bash_output`: a background command's status and new output, after waiting when asked. */
export function createBashOutputTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  commands: BackgroundCommands
): ModelTool<BashOutputToolInput> {
  return {
    ...BASH_OUTPUT_TOOL_SPEC,
    parseInput: (value) => {
      const input = parseInput(BASH_OUTPUT_TOOL_SPEC.name, value, ["id", "wait"])
      if (input.wait !== undefined && (typeof input.wait !== "number" || input.wait < 0)) {
        throw publicError(BASH_OUTPUT_TOOL_SPEC.name, "wait must be a number of milliseconds.")
      }
      return {
        id: input.id as string,
        ...(input.wait === undefined ? {} : { wait: Math.min(input.wait as number, MAX_WAIT_MS) }),
      }
    },
    async execute(input, { signal }): Promise<JsonValue> {
      commands.get(input.id)
      if (input.wait) await commands.wait(input.id, input.wait, signal)

      const output: BackgroundCommandOutput = await commands.read(
        input.id,
        await resolveSandbox(),
        signal
      )
      return output as unknown as JsonValue
    },
    errorText: agentToolErrorText,
  }
}

/** `bash_stop`: stop a background command, then report how it ended and its last output. */
export function createBashStopTool(
  resolveSandbox: () => Promise<AgentSandboxHandle>,
  commands: BackgroundCommands
): ModelTool<BashStopToolInput> {
  return {
    ...BASH_STOP_TOOL_SPEC,
    parseInput: (value) => ({
      id: parseInput(BASH_STOP_TOOL_SPEC.name, value, ["id"]).id as string,
    }),
    async execute(input, { signal }): Promise<JsonValue> {
      await commands.stop(input.id)

      const output: BackgroundCommandOutput = await commands.read(
        input.id,
        await resolveSandbox(),
        signal
      )
      return output as unknown as JsonValue
    },
    errorText: agentToolErrorText,
  }
}

function parseInput(
  tool: string,
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> & { readonly id: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw publicError(tool, "input must be an object.")
  }
  const input = value as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw publicError(tool, `input contains unknown property '${key}'.`)
  }
  if (typeof input.id !== "string" || !input.id) {
    throw publicError(tool, "id must be a background command's id, such as bg_3f9a1c.")
  }
  return input as Record<string, unknown> & { readonly id: string }
}

function publicError(tool: string, message: string): AgentToolPublicError {
  return new AgentToolPublicError(`[SixbAgent] ${tool} ${message}`)
}
