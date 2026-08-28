import { fail } from "./output"

export function isHelp(value: string | undefined): boolean {
  return value === "-h" || value === "--help" || value === "help"
}

export function requireValue(label: string, value: string | undefined): string {
  if (!value) fail(`${label} requires a value.`)
  return value
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
