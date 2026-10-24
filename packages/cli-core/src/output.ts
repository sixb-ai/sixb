/** Version of the stable JSON and command contract. */
export const INSTANCE_CLI_VERSION = "1"
export const EXIT_USAGE = 2
export const EXIT_API = 3
/** The request waits for its user's approval: it did not run. */
export const EXIT_AWAITING_APPROVAL = 4

export interface CliErrorBody {
  readonly code: string
  readonly status?: number
  readonly message: string
  readonly hint?: string
  readonly issues?: readonly unknown[]
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

/** Ends a command that already wrote its output, with an exit code that is not a success. */
export class CliExit extends Error {
  constructor(readonly exitCode: number) {
    super(`The Sixb CLI exited with code ${exitCode}.`)
    this.name = "CliExit"
  }
}

/**
 * Print what a request that changes state answered. A request held for the user's approval prints
 * as the API answered it, and exits with {@link EXIT_AWAITING_APPROVAL}: `a && b` does not run `b`.
 */
export function writeRequestResult(value: unknown): void {
  writeJson(value)
  const status = typeof value === "object" && value !== null ? Reflect.get(value, "status") : null
  if (status === "awaiting_approval") throw new CliExit(EXIT_AWAITING_APPROVAL)
}

export function writeText(value: string): void {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`)
}

export function reportError(error: unknown): number {
  if (error instanceof CliExit) return error.exitCode
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
