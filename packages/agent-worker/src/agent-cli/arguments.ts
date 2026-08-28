import { fail } from "./output"

const RFC3339_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

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
