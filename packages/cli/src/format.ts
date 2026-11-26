import { writeJson, writeText } from "./output"

/**
 * Emit structured JSON when stdout is not a TTY (pipes, CI, sandboxes), when `--json` is passed,
 * or when `SIXB_OUTPUT=json`. Otherwise render compact human-readable plain text.
 */
export function wantsJson(explicitJson?: boolean): boolean {
  if (explicitJson === true) return true
  if (process.env.SIXB_OUTPUT === "json") return true
  return process.stdout.isTTY !== true
}

export function renderOutput(
  data: unknown,
  options: {
    readonly json?: boolean
    readonly renderText: () => string
  }
): void {
  if (wantsJson(options.json)) {
    writeJson(data)
    return
  }
  writeText(options.renderText())
}

const useColor = () => process.stdout.isTTY === true && !process.env.NO_COLOR

export const style = {
  bold: (text: string) => (useColor() ? `\x1b[1m${text}\x1b[0m` : text),
  dim: (text: string) => (useColor() ? `\x1b[2m${text}\x1b[0m` : text),
  blue: (text: string) => (useColor() ? `\x1b[34m${text}\x1b[0m` : text),
  green: (text: string) => (useColor() ? `\x1b[32m${text}\x1b[0m` : text),
  red: (text: string) => (useColor() ? `\x1b[31m${text}\x1b[0m` : text),
}

export interface TableOptions {
  readonly title?: string
  readonly subtitle?: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly emptyMessage?: string
}

export function renderTable(options: TableOptions): string {
  const lines: string[] = []
  if (options.title || options.subtitle) {
    const heading = [
      options.title ? style.bold(options.title) : "",
      options.subtitle ? style.dim(options.subtitle) : "",
    ]
      .filter(Boolean)
      .join("  ")
    lines.push(heading)
  }

  if (options.rows.length === 0) {
    lines.push(style.dim(options.emptyMessage ?? "No results."))
    return lines.join("\n")
  }

  const widths = options.headers.map((header, column) =>
    Math.max(header.length, ...options.rows.map((row) => (row[column] ?? "").length))
  )
  const formatRow = (cells: readonly string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ")

  lines.push(style.dim(formatRow(options.headers)))
  for (const row of options.rows) {
    lines.push(formatRow(options.headers.map((_, index) => row[index] ?? "")))
  }
  return lines.join("\n")
}

export interface KeyValueItem {
  readonly label: string
  readonly value: string
}

export function renderKeyValues(options: {
  readonly title?: string
  readonly titleTone?: "default" | "green" | "red"
  readonly subtitle?: string
  readonly items: readonly KeyValueItem[]
  readonly note?: string
}): string {
  const lines: string[] = []
  if (options.title) {
    const painted =
      options.titleTone === "green"
        ? style.green(style.bold(options.title))
        : options.titleTone === "red"
          ? style.red(style.bold(options.title))
          : style.bold(options.title)
    lines.push(options.subtitle ? `${painted}  ${style.dim(options.subtitle)}` : painted)
  }
  const width = Math.max(0, ...options.items.map((item) => item.label.length))
  for (const item of options.items) {
    lines.push(`${style.dim(`${item.label.padEnd(width)}:`)} ${item.value}`)
  }
  if (options.note) lines.push("", options.note)
  return lines.join("\n")
}

export function formatShortDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "—"
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toISOString().slice(0, 10)
}

export function formatGroups(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return "all"
  return value.map(String).join(", ")
}
