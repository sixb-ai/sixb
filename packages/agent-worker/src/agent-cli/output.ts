export const AGENT_CLI_VERSION = "1"
export const EXIT_USAGE = 2
export const EXIT_API = 3

export interface CliErrorBody {
  readonly code: string
  readonly status?: number
  readonly message: string
  readonly hint?: string
}

export class CliError extends Error {
  readonly body: CliErrorBody
  readonly exitCode: number

  constructor(body: CliErrorBody, exitCode = EXIT_USAGE) {
    super(body.message)
    this.name = "CliError"
    this.body = body
    this.exitCode = exitCode
  }
}

export function fail(message: string, code = "invalid_arguments", hint?: string): never {
  throw new CliError({ code, message, ...(hint ? { hint } : {}) })
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function writeText(value: string): void {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`)
}

export function reportError(error: unknown): number {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(
          {
            code: "internal_error",
            message: error instanceof Error ? error.message : "The Sixb CLI failed unexpectedly.",
          },
          EXIT_API
        )
  process.stderr.write(`${JSON.stringify({ error: cliError.body })}\n`)
  return cliError.exitCode
}
