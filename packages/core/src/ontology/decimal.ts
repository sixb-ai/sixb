const decimalPattern = /^([+-]?)(\d+)(?:\.(\d+))?$/
// Matches PostgreSQL's unconstrained NUMERIC limits so every accepted value can
// be compared exactly by all providers that advertise exact-decimal support.
const maxIntegerDigits = 131_072
const maxFractionDigits = 16_383

declare const decimalValueBrand: unique symbol

/**
 * Exact, JSON-safe decimal value used by ontology `"decimal"` schemas.
 *
 * Runtime values are canonical strings. The brand prevents ordinary strings
 * from being passed accidentally through typed SDK surfaces; use {@link decimal}
 * to construct one.
 */
export type DecimalValue = string & { readonly [decimalValueBrand]: true }

interface DecimalParts {
  readonly negative: boolean
  readonly integer: string
  readonly fraction: string
}

/** Construct a canonical exact decimal without converting through a JS number. */
export function decimal(value: string | bigint): DecimalValue {
  return normalizeDecimalValue(value)
}

/**
 * Normalize an exact decimal to a stable JSON representation.
 *
 * Leading integer zeroes, trailing fractional zeroes, `+`, and negative zero
 * are removed so numerically equal values also compare equal as stored strings.
 */
export function normalizeDecimalValue(value: string | bigint): DecimalValue {
  const input = typeof value === "bigint" ? value.toString() : value.trim()
  const match = decimalPattern.exec(input)
  if (!match) {
    throw new TypeError("[Sixb] Invalid decimal value.")
  }

  const integer = normalizeInteger(match[2])
  const fraction = (match[3] ?? "").replace(/0+$/, "")
  if (integer.length > maxIntegerDigits || fraction.length > maxFractionDigits) {
    throw new TypeError("[Sixb] Decimal value exceeds the supported precision.")
  }
  const negative = match[1] === "-" && (integer !== "0" || fraction.length > 0)
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}` as DecimalValue
}

/** True when a value is a syntactically valid exact decimal string. */
export function isDecimalString(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    normalizeDecimalValue(value)
    return true
  } catch {
    return false
  }
}

/** True when a value already uses the canonical `DecimalValue` representation. */
export function isDecimalValue(value: unknown): value is DecimalValue {
  if (!isDecimalString(value)) return false
  return normalizeDecimalValue(value) === value
}

/** Compare two exact decimals without converting through a JS number. */
export function compareDecimalValues(left: string, right: string): number {
  const leftParts = decimalParts(normalizeDecimalValue(left))
  const rightParts = decimalParts(normalizeDecimalValue(right))

  if (leftParts.negative !== rightParts.negative) {
    return leftParts.negative ? -1 : 1
  }

  const magnitude = compareMagnitude(leftParts, rightParts)
  return leftParts.negative ? -magnitude : magnitude
}

function normalizeInteger(value: string): string {
  return value.replace(/^0+(?=\d)/, "")
}

function decimalParts(value: DecimalValue): DecimalParts {
  const negative = value.startsWith("-")
  const unsigned = negative ? value.slice(1) : value
  const separator = unsigned.indexOf(".")
  return {
    negative,
    integer: separator === -1 ? unsigned : unsigned.slice(0, separator),
    fraction: separator === -1 ? "" : unsigned.slice(separator + 1),
  }
}

function compareMagnitude(left: DecimalParts, right: DecimalParts): number {
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -1 : 1
  }

  const integerComparison = compareStrings(left.integer, right.integer)
  if (integerComparison !== 0) return integerComparison
  return compareFraction(left.fraction, right.fraction)
}

function compareFraction(left: string, right: string): number {
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const leftDigit = left.charCodeAt(index) || 48
    const rightDigit = right.charCodeAt(index) || 48
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1
  }
  return 0
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
