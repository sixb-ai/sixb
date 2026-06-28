import type { CommandResult, Sandbox } from "@sixb/core"
import { jsonSchema, type Tool, tool } from "ai"

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const MAX_COMMAND_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_CHARS = 16_000

interface BashToolInput {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface BashToolOutput extends CommandResult {
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export interface BashToolOptions {
  readonly env?: Readonly<Record<string, string>>
}

export function createBashTool(
  sandbox: Sandbox,
  options: BashToolOptions = {}
): Tool<BashToolInput, BashToolOutput> {
  return tool({
    description: "Run a Bash command in the agent run sandbox.",
    inputSchema: jsonSchema<BashToolInput>({
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    async execute(input, { abortSignal }): Promise<BashToolOutput> {
      const result = await sandbox.runCommand("bash", ["-lc", input.command], {
        cwd: input.cwd,
        env: options.env,
        timeout: normalizeTimeout(input.timeoutMs),
        signal: abortSignal,
      })
      return truncateCommandResult(result)
    },
  })
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS
  }
  return Math.min(Math.floor(timeoutMs), MAX_COMMAND_TIMEOUT_MS)
}

function truncateCommandResult(result: CommandResult): BashToolOutput {
  const stdout = truncateText(result.stdout, DEFAULT_MAX_OUTPUT_CHARS)
  const stderr = truncateText(result.stderr, DEFAULT_MAX_OUTPUT_CHARS)
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  }
}

function truncateText(
  text: string,
  maxChars: number
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }
  return {
    text: `${text.slice(0, maxChars)}\n[SixbAgentWorker] output truncated to ${maxChars} characters.`,
    truncated: true,
  }
}
