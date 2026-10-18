import { AGGREGATE_FUNCTIONS } from "./check"
import type { FormulaNode } from "./parser"

/** What a cell computes to when it can't: a division by zero, or a value of the wrong kind. */
export const FORMULA_ERRORS = ["#DIV/0!", "#VALUE!"] as const
export type FormulaErrorCode = (typeof FORMULA_ERRORS)[number]

/**
 * A value as a formula sees it: a number (a date is its day count, as in Excel), text, a boolean,
 * a blank, or an error that passes through everything but IFERROR.
 */
export type FormulaValue = number | string | boolean | null | { readonly error: FormulaErrorCode }

/** The values a formula reads: this row's in a column, or a whole column's. */
export interface FormulaScope {
  readonly cell: (column: string) => FormulaValue
  readonly column: (column: string) => readonly FormulaValue[]
}

const isError = (value: FormulaValue): value is { readonly error: FormulaErrorCode } =>
  typeof value === "object" && value !== null
const fault = (error: FormulaErrorCode) => ({ error }) as const

/**
 * Evaluates a formula for one row, with Excel's rules: a blank reads as 0 in arithmetic and as
 * empty text in `&`; booleans count as 1 and 0; text that reads as a number is one; text compares
 * without regard to case, and number < text < boolean across kinds. An aggregate over whole
 * columns is the same for every row, so `memo` keeps it once computed.
 */
export function evaluateFormula(
  node: FormulaNode,
  scope: FormulaScope,
  memo: Map<FormulaNode, FormulaValue> = new Map()
): FormulaValue {
  const value = (current: FormulaNode): FormulaValue => {
    switch (current.kind) {
      case "number":
      case "text":
      case "boolean":
        return current.value
      case "ref":
        return scope.cell(current.column)
      case "columnRef":
        // The checker allows a whole column only inside an aggregate, which reads it itself.
        return fault("#VALUE!")
      case "unary": {
        const operand = number(value(current.operand))
        if (isError(operand)) return operand
        return current.op === "-" ? -operand : operand
      }
      case "binary":
        return binary(current.op, value(current.left), value(current.right))
      case "call": {
        const constant = AGGREGATE_FUNCTIONS.has(current.name) && current.args.every(isConstant)
        if (constant && memo.has(current)) return memo.get(current) as FormulaValue
        const result = call(current.name, current.args, value, scope)
        if (constant) memo.set(current, result)
        return result
      }
    }
  }
  return value(node)
}

/** A literal, or a whole column: the same in every row. */
function isConstant(node: FormulaNode): boolean {
  return node.kind === "columnRef" || node.kind === "number" || node.kind === "text"
}

function number(value: FormulaValue): number | { readonly error: FormulaErrorCode } {
  if (isError(value)) return value
  if (value === null) return 0
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return value
  const trimmed = value.trim()
  const parsed = trimmed ? Number(trimmed) : Number.NaN
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed) && Number.isFinite(parsed)
    ? parsed
    : fault("#VALUE!")
}

/** A value as text: a number as Excel's General format writes it, a boolean as TRUE or FALSE. */
export function formulaText(value: Exclude<FormulaValue, { error: unknown }>): string {
  if (value === null) return ""
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return String(Number(value.toPrecision(15)))
  return value
}

function truth(value: FormulaValue): boolean | { readonly error: FormulaErrorCode } {
  if (isError(value)) return value
  if (value === null) return false
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  const word = value.trim().toUpperCase()
  return word === "TRUE" ? true : word === "FALSE" ? false : fault("#VALUE!")
}

const finite = (result: number) => (Number.isFinite(result) ? result : fault("#VALUE!"))

function binary(
  op: Extract<FormulaNode, { kind: "binary" }>["op"],
  left: FormulaValue,
  right: FormulaValue
): FormulaValue {
  if (isError(left)) return left
  if (isError(right)) return right
  if (op === "&") return formulaText(left) + formulaText(right)
  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const order = compare(left, right)
    return {
      "=": order === 0,
      "<>": order !== 0,
      "<": order < 0,
      "<=": order <= 0,
      ">": order > 0,
      ">=": order >= 0,
    }[op]
  }
  const a = number(left)
  const b = number(right)
  if (isError(a)) return a
  if (isError(b)) return b
  switch (op) {
    case "+":
      return finite(a + b)
    case "-":
      return finite(a - b)
    case "*":
      return finite(a * b)
    case "/":
      return b === 0 ? fault("#DIV/0!") : finite(a / b)
    case "^":
      return a === 0 && b < 0 ? fault("#DIV/0!") : finite(a ** b)
  }
}

/** Excel's order: a blank takes the other side's kind, then number < text < boolean. */
function compare(
  left: Exclude<FormulaValue, { error: unknown }>,
  right: Exclude<FormulaValue, { error: unknown }>
): number {
  const blank = (other: typeof left) =>
    typeof other === "number" ? 0 : typeof other === "boolean" ? false : ""
  const a = left === null ? blank(right) : left
  const b = right === null ? blank(left) : right
  const rank = (value: typeof a) =>
    typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  if (typeof a === "string" && typeof b === "string") {
    const x = a.toLowerCase()
    const y = b.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  return Number(a) - Number(b)
}

/** Days from Excel's day zero, 1899-12-30, to 1970-01-01. */
const EPOCH_SERIAL = 25569
const DAY_MS = 86_400_000

/** A date as Excel's day count. */
export function dateSerial(date: Date): number {
  return date.getTime() / DAY_MS + EPOCH_SERIAL
}

/** A day count as the date it is: `2026-09-30`, or with its time when it has one. */
export function serialDate(serial: number): string {
  const date = new Date(Math.round((serial - EPOCH_SERIAL) * DAY_MS))
  const iso = date.toISOString()
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`
}

function call(
  name: string,
  args: readonly FormulaNode[],
  value: (node: FormulaNode) => FormulaValue,
  scope: FormulaScope
): FormulaValue {
  const at = (index: number) => value(args[index] as FormulaNode)
  switch (name) {
    case "IF": {
      const condition = truth(at(0))
      if (isError(condition)) return condition
      if (condition) return at(1)
      return args.length > 2 ? at(2) : false
    }
    case "IFERROR": {
      const result = at(0)
      return isError(result) ? at(1) : result
    }
    case "AND":
    case "OR": {
      const values = args.map((_, index) => at(index)).filter((entry) => entry !== null)
      if (values.length === 0) return fault("#VALUE!")
      let result = name === "AND"
      for (const entry of values) {
        const flag = truth(entry)
        if (isError(flag)) return flag
        result = name === "AND" ? result && flag : result || flag
      }
      return result
    }
    case "NOT": {
      const flag = truth(at(0))
      return isError(flag) ? flag : !flag
    }
    case "ISBLANK":
      return at(0) === null
    case "ROUND": {
      const x = number(at(0))
      const digits = number(at(1))
      if (isError(x)) return x
      if (isError(digits)) return digits
      // Half away from zero, as Excel rounds, past the float error of the scaled value.
      const scale = 10 ** Math.trunc(digits)
      return (Math.sign(x) * Math.round(Number((Math.abs(x) * scale).toPrecision(15)))) / scale
    }
    case "ABS": {
      const x = number(at(0))
      return isError(x) ? x : Math.abs(x)
    }
    case "LEN":
    case "LOWER":
    case "UPPER": {
      const text = at(0)
      if (isError(text)) return text
      const written = formulaText(text)
      return name === "LEN"
        ? written.length
        : name === "LOWER"
          ? written.toLowerCase()
          : written.toUpperCase()
    }
    case "CONCAT": {
      let text = ""
      for (const index of args.keys()) {
        const part = at(index)
        if (isError(part)) return part
        text += formulaText(part)
      }
      return text
    }
    case "YEAR":
    case "MONTH": {
      const serial = number(at(0))
      if (isError(serial)) return serial
      if (serial < 0) return fault("#VALUE!")
      const date = new Date((Math.floor(serial) - EPOCH_SERIAL) * DAY_MS)
      return name === "YEAR" ? date.getUTCFullYear() : date.getUTCMonth() + 1
    }
    case "DAYS": {
      const end = number(at(0))
      const start = number(at(1))
      if (isError(end)) return end
      if (isError(start)) return start
      return Math.floor(end) - Math.floor(start)
    }
    default: {
      // SUM, AVERAGE, MIN, MAX, COUNT: the numbers among their arguments, whole columns included;
      // text, booleans, and blanks are passed over, as a range's are in Excel.
      const numbers: number[] = []
      for (const [index, arg] of args.entries()) {
        const values = arg.kind === "columnRef" ? scope.column(arg.column) : [at(index)]
        for (const entry of values) {
          if (isError(entry)) return entry
          if (typeof entry === "number") numbers.push(entry)
        }
      }
      switch (name) {
        case "COUNT":
          return numbers.length
        case "SUM":
          return numbers.reduce((sum, entry) => sum + entry, 0)
        case "AVERAGE":
          return numbers.length === 0
            ? fault("#DIV/0!")
            : numbers.reduce((sum, entry) => sum + entry, 0) / numbers.length
        case "MIN":
          return numbers.length === 0 ? 0 : numbers.reduce((min, entry) => Math.min(min, entry))
        case "MAX":
          return numbers.length === 0 ? 0 : numbers.reduce((max, entry) => Math.max(max, entry))
        default:
          return fault("#VALUE!")
      }
    }
  }
}
