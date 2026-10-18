/**
 * A computed column's formula, as an Excel table writes one: `([@Revenue]-[@Cost])/[@Revenue]`.
 * `[@Name]` is this row's value in a column, `[Name]` the whole column (only inside an aggregate),
 * and a name holding brackets or other special characters is bracketed again: `[@[Lead (weeks)]]`.
 * In a name, `'` escapes the next character, as in Excel.
 */
export type FormulaNode =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  /** This row's value in a column. */
  | { readonly kind: "ref"; readonly column: string }
  /** Every value of a column. */
  | { readonly kind: "columnRef"; readonly column: string }
  | { readonly kind: "unary"; readonly op: "-" | "+"; readonly operand: FormulaNode }
  | {
      readonly kind: "binary"
      readonly op: FormulaOperator
      readonly left: FormulaNode
      readonly right: FormulaNode
    }
  | { readonly kind: "call"; readonly name: string; readonly args: readonly FormulaNode[] }

export type FormulaOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="

/** A formula that does not parse, with what is wrong where, from the first character as 1. */
export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message)
    this.name = "FormulaSyntaxError"
  }
}

type Token =
  | { readonly kind: "number"; readonly value: number; readonly at: number }
  | { readonly kind: "text"; readonly value: string; readonly at: number }
  | { readonly kind: "name"; readonly value: string; readonly at: number }
  | { readonly kind: "ref"; readonly column: string; readonly row: boolean; readonly at: number }
  | { readonly kind: "op"; readonly value: string; readonly at: number }
  | { readonly kind: "end"; readonly at: number }

const OPERATORS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">", "(", ")", ","]

function tokens(source: string): Token[] {
  const list: Token[] = []
  let index = 0
  const fail = (message: string, at = index): never => {
    throw new FormulaSyntaxError(`${message} at character ${at + 1}.`, at + 1)
  }
  /** A column's name up to its closing bracket, `'` escaping the next character. */
  const name = (): string => {
    let value = ""
    while (index < source.length && source[index] !== "]") {
      if (source[index] === "[") fail("A column's name holds '[': escape it as '[")
      if (source[index] === "'") index += 1
      value += source[index] ?? ""
      index += 1
    }
    if (source[index] !== "]") fail("A column reference is never closed with ']'")
    index += 1
    return value.trim()
  }
  while (index < source.length) {
    const char = source[index] as string
    const at = index
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      const match = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(source.slice(index))
      if (!match) fail("A number is not written right")
      index += (match as RegExpExecArray)[0].length
      list.push({ kind: "number", value: Number((match as RegExpExecArray)[0]), at })
      continue
    }
    if (char === '"') {
      let value = ""
      index += 1
      for (;;) {
        if (index >= source.length) fail("A text in quotes is never closed", at)
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index += 1
          break
        }
        value += source[index]
        index += 1
      }
      list.push({ kind: "text", value, at })
      continue
    }
    if (char === "[") {
      index += 1
      const row = source[index] === "@"
      if (row) index += 1
      let column: string
      if (source[index] === "[") {
        index += 1
        column = name()
        if (source[index] !== "]") fail("A bracketed column name needs its outer ']'")
        index += 1
      } else {
        column = name()
      }
      if (!column) fail("A column reference names no column", at)
      list.push({ kind: "ref", column, row, at })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(index)) as RegExpExecArray
      index += match[0].length
      list.push({ kind: "name", value: match[0].toUpperCase(), at })
      continue
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index))
    if (!operator) fail(`'${char}' is not part of a formula`)
    index += (operator as string).length
    list.push({ kind: "op", value: operator as string, at })
  }
  list.push({ kind: "end", at: source.length })
  return list
}

/** How tightly each operator binds its operands; all bind leftward, `^` too: `2^3^2` is 64. */
const BINDING: Readonly<Record<string, number>> = {
  "=": 10,
  "<>": 10,
  "<": 10,
  "<=": 10,
  ">": 10,
  ">=": 10,
  "&": 20,
  "+": 30,
  "-": 30,
  "*": 40,
  "/": 40,
  "^": 50,
}
/** A sign binds tighter than `^`: `-2^2` is 4, as Excel reads it. */
const PREFIX = 60

/**
 * Parses a formula, with or without its leading `=`. Throws a {@link FormulaSyntaxError} that
 * says what is wrong and where.
 */
export function parseFormula(text: string): FormulaNode {
  const source = text.trim().replace(/^=/, "")
  const list = tokens(source)
  let position = 0
  const peek = () => list[position] as Token
  const next = () => list[position++] as Token
  const fail = (message: string, token: Token): never => {
    throw new FormulaSyntaxError(`${message} at character ${token.at + 1}.`, token.at + 1)
  }
  const expect = (value: string) => {
    const token = next()
    if (token.kind !== "op" || token.value !== value) {
      fail(`Expected '${value}'`, token)
    }
  }

  const expression = (binding: number): FormulaNode => {
    let left = operand()
    for (;;) {
      const token = peek()
      if (token.kind !== "op") break
      const power = BINDING[token.value]
      if (power === undefined || power <= binding) break
      next()
      const right = expression(power)
      left = { kind: "binary", op: token.value as FormulaOperator, left, right }
    }
    return left
  }

  const operand = (): FormulaNode => {
    const token = next()
    switch (token.kind) {
      case "number":
        return { kind: "number", value: token.value }
      case "text":
        return { kind: "text", value: token.value }
      case "ref":
        return token.row
          ? { kind: "ref", column: token.column }
          : { kind: "columnRef", column: token.column }
      case "name": {
        if (token.value === "TRUE" || token.value === "FALSE") {
          return { kind: "boolean", value: token.value === "TRUE" }
        }
        if (peek().kind !== "op" || (peek() as { value: string }).value !== "(") {
          return fail(
            `'${token.value}' is not a function call or a reference; a column is written [@Name]`,
            token
          )
        }
        next()
        const args: FormulaNode[] = []
        if (!(peek().kind === "op" && (peek() as { value: string }).value === ")")) {
          for (;;) {
            args.push(expression(0))
            const separator = peek()
            if (separator.kind === "op" && separator.value === ",") {
              next()
              continue
            }
            break
          }
        }
        expect(")")
        return { kind: "call", name: token.value, args }
      }
      case "op":
        if (token.value === "(") {
          const inner = expression(0)
          expect(")")
          return inner
        }
        if (token.value === "-" || token.value === "+") {
          return { kind: "unary", op: token.value, operand: expression(PREFIX) }
        }
        return fail(`'${token.value}' can't start a value`, token)
      case "end":
        return fail("The formula ends where a value is expected", token)
    }
  }

  const tree = expression(0)
  const rest = peek()
  if (rest.kind !== "end") fail("The formula goes on after a complete value", rest)
  return tree
}

/** The columns a formula reads, by row or whole. */
export function formulaDependencies(node: FormulaNode): Set<string> {
  const columns = new Set<string>()
  const visit = (current: FormulaNode) => {
    switch (current.kind) {
      case "ref":
      case "columnRef":
        columns.add(current.column)
        return
      case "unary":
        visit(current.operand)
        return
      case "binary":
        visit(current.left)
        visit(current.right)
        return
      case "call":
        for (const arg of current.args) visit(arg)
        return
      default:
        return
    }
  }
  visit(node)
  return columns
}
