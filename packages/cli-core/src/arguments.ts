import { fail } from "./output"

type OptionKinds = Readonly<Record<string, "string" | "boolean">>

/** Parse a command's options once, before reading files or calling the API. */
export function parseCommandArgs<const T extends OptionKinds>(
  args: readonly string[],
  kinds: T,
  command: string,
  positionalCount: number | readonly [number, number] = 0
): {
  positionals: string[]
  options: { [K in keyof T]?: T[K] extends "boolean" ? boolean : string }
} {
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}
  let positionalOnly = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? ""
    if (!positionalOnly && argument === "--") {
      positionalOnly = true
      continue
    }
    if (positionalOnly || !argument.startsWith("-") || argument === "-") {
      positionals.push(argument)
      continue
    }
    const equals = argument.indexOf("=")
    const flag = equals < 0 ? argument : argument.slice(0, equals)
    if (!Object.hasOwn(kinds, flag)) fail(`Unknown ${command} option '${flag}'.`)
    if (Object.hasOwn(options, flag)) fail(`${flag} may only be provided once.`)
    if (kinds[flag] === "boolean") {
      if (equals >= 0) fail(`${flag} does not accept a value.`)
      options[flag] = true
    } else {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1)
      if (!value || (equals < 0 && value.startsWith("--"))) {
        fail(`${flag} requires a value.`)
      }
      options[flag] = value
    }
  }
  const [minimum, maximum] =
    typeof positionalCount === "number" ? [positionalCount, positionalCount] : positionalCount
  if (positionals.length < minimum || positionals.length > maximum) {
    fail(`Invalid arguments for '${command}'.`)
  }
  return {
    positionals,
    // Every assigned option was checked against its declared kind above.
    options: options as { [K in keyof T]?: T[K] extends "boolean" ? boolean : string },
  }
}

export function requestsHelp(args: readonly string[]): boolean {
  const separator = args.indexOf("--")
  const beforeSeparator = separator < 0 ? args : args.slice(0, separator)
  return isHelp(args[0]) || beforeSeparator.includes("--help") || beforeSeparator.includes("-h")
}

/** Argument validation shared by every instance command mode. */

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function isHelp(value: string | undefined): boolean {
  return value === "-h" || value === "--help" || value === "help"
}

export function requireExact(args: readonly string[], count: number, message: string): void {
  if (args.length !== count) fail(message)
}

export function integerInRange(
  flag: string,
  value: string,
  minimum: number,
  maximum: number
): number {
  if (!/^[0-9]+$/.test(value)) {
    fail(`${flag} must be an integer from ${minimum} through ${maximum}.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${flag} must be an integer from ${minimum} through ${maximum}.`)
  }
  return parsed
}

export function nonNegativeInteger(flag: string, value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    fail(`${flag} must be a non-negative integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    fail(`${flag} must be a non-negative safe integer.`)
  }
  return parsed
}

export function rfc3339Value(flag: string, value: string): string {
  if (!RFC3339_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${flag} must be an RFC 3339 timestamp.`)
  }
  return value
}

export function requireOrderedRange(
  afterFlag: string,
  after: string | undefined,
  beforeFlag: string,
  before: string | undefined
): void {
  if (after && before && Date.parse(after) > Date.parse(before)) {
    fail(`${afterFlag} must be before or equal to ${beforeFlag}.`)
  }
}

export function enumValue<const T extends readonly string[]>(
  flag: string,
  value: string,
  allowed: T
): T[number] {
  if (!allowed.includes(value)) fail(`${flag} must be ${formatAlternatives(allowed)}.`)
  return value as T[number]
}

function formatAlternatives(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? "a supported value"
  return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`
}
