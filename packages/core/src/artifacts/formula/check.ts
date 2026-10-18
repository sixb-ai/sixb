import type { FormulaNode } from "./parser"

/**
 * What a formula yields, as far as its operands say: a date is a number of days that reads as a
 * date, and `any` is a value whose kind depends on the row, such as an IF's two kinds of branch.
 */
export type FormulaType = "number" | "date" | "text" | "boolean" | "any"

/** Every function a formula may call, with how many arguments it takes. */
export const FORMULA_FUNCTIONS: Readonly<
  Record<string, { readonly min: number; readonly max: number }>
> = {
  IF: { min: 2, max: 3 },
  IFERROR: { min: 2, max: 2 },
  AND: { min: 1, max: 30 },
  OR: { min: 1, max: 30 },
  NOT: { min: 1, max: 1 },
  ISBLANK: { min: 1, max: 1 },
  ROUND: { min: 2, max: 2 },
  ABS: { min: 1, max: 1 },
  MIN: { min: 1, max: 30 },
  MAX: { min: 1, max: 30 },
  SUM: { min: 1, max: 30 },
  AVERAGE: { min: 1, max: 30 },
  COUNT: { min: 1, max: 30 },
  LEN: { min: 1, max: 1 },
  LOWER: { min: 1, max: 1 },
  UPPER: { min: 1, max: 1 },
  CONCAT: { min: 1, max: 30 },
  YEAR: { min: 1, max: 1 },
  MONTH: { min: 1, max: 1 },
  DAYS: { min: 2, max: 2 },
}

/** The functions that read a whole column, `[Name]`, and reduce it to one value. */
export const AGGREGATE_FUNCTIONS: ReadonlySet<string> = new Set([
  "SUM",
  "AVERAGE",
  "MIN",
  "MAX",
  "COUNT",
])

/**
 * Checks a formula against the columns its sheet has, each by what its values are: what it yields,
 * or what is wrong with it, in words an author can act on. Text where a number is needed is
 * refused here rather than computed to `#VALUE!` in every row.
 */
export function checkFormula(
  node: FormulaNode,
  columns: ReadonlyMap<string, FormulaType>
): { readonly type: FormulaType } | { readonly error: string } {
  try {
    return { type: typeOf(node, columns, false) }
  } catch (error) {
    if (error instanceof FormulaCheckError) return { error: error.message }
    throw error
  }
}

class FormulaCheckError extends Error {}

const numeric = (type: FormulaType) => type !== "text"

function typeOf(
  node: FormulaNode,
  columns: ReadonlyMap<string, FormulaType>,
  inAggregate: boolean
): FormulaType {
  switch (node.kind) {
    case "number":
      return "number"
    case "text":
      return "text"
    case "boolean":
      return "boolean"
    case "ref":
    case "columnRef": {
      const type = columns.get(node.column)
      if (type === undefined) {
        throw new FormulaCheckError(
          `it reads column '${node.column}', which the sheet does not have`
        )
      }
      if (node.kind === "columnRef" && !inAggregate) {
        throw new FormulaCheckError(
          `[${node.column}] is the whole column, which only ${[...AGGREGATE_FUNCTIONS].join(", ")} take; this row's value is [@${node.column}]`
        )
      }
      return type
    }
    case "unary": {
      const type = typeOf(node.operand, columns, false)
      if (!numeric(type)) throw new FormulaCheckError(`'${node.op}' needs a number, not text`)
      return "number"
    }
    case "binary": {
      const left = typeOf(node.left, columns, false)
      const right = typeOf(node.right, columns, false)
      switch (node.op) {
        case "&":
          return "text"
        case "=":
        case "<>":
        case "<":
        case "<=":
        case ">":
        case ">=":
          return "boolean"
        default: {
          if (!numeric(left) || !numeric(right)) {
            throw new FormulaCheckError(`'${node.op}' needs numbers on both sides, not text`)
          }
          // A date and a number of days make a date; two dates make the days between them.
          if (node.op === "+" && (left === "date") !== (right === "date")) return "date"
          if (node.op === "-" && left === "date" && right !== "date") return "date"
          return "number"
        }
      }
    }
    case "call": {
      const shape = FORMULA_FUNCTIONS[node.name]
      if (!shape) {
        throw new FormulaCheckError(
          `${node.name} is not a function a sheet computes; use one of ${Object.keys(FORMULA_FUNCTIONS).join(", ")}`
        )
      }
      if (node.args.length < shape.min || node.args.length > shape.max) {
        const count =
          shape.min === shape.max
            ? `${shape.min}`
            : shape.max === 30
              ? `at least ${shape.min}`
              : `${shape.min} or ${shape.max}`
        throw new FormulaCheckError(
          `${node.name} takes ${count} ${shape.max === 1 ? "argument" : "arguments"}, not ${node.args.length}`
        )
      }
      const aggregate = AGGREGATE_FUNCTIONS.has(node.name)
      const args = node.args.map((arg) => typeOf(arg, columns, aggregate))
      switch (node.name) {
        case "IF": {
          const [, then = "boolean", otherwise = "boolean"] = args
          return then === otherwise ? then : "any"
        }
        case "IFERROR": {
          const [value = "any", fallback = "any"] = args
          return value === fallback ? value : "any"
        }
        case "AND":
        case "OR":
        case "NOT":
        case "ISBLANK":
          return "boolean"
        case "LOWER":
        case "UPPER":
        case "CONCAT":
          return "text"
        default:
          for (const [index, type] of args.entries()) {
            if (node.name !== "LEN" && !aggregate && !numeric(type)) {
              throw new FormulaCheckError(
                `${node.name}'s argument ${index + 1} needs a number, not text`
              )
            }
          }
          return "number"
      }
    }
  }
}
