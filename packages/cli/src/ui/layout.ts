import { glyph, paint, palette, tone } from "./theme"

/**
 * Printed screens are strings: built here, written once, kept in the scrollback, and plain text
 * when piped. Every screen sits two columns in and between blank lines.
 */
export const GUTTER = "  "

export type Block = string | null | undefined | false

/** Joins blocks with a blank line between them, indented, with breathing room above and below. */
export function screen(...blocks: Block[]): string {
  const body = blocks
    .filter((block): block is string => typeof block === "string" && block.length > 0)
    .join("\n\n")
  return `\n${indent(body)}\n\n`
}

/** Joins blocks with no blank line between them. */
export function stack(...blocks: Block[]): string {
  return blocks.filter((block): block is string => typeof block === "string").join("\n")
}

export function indent(text: string, prefix = GUTTER): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n")
}

/**
 * Columns the output can use, less the gutter. Piped output never wraps: a log line stays one
 * line, so it still greps.
 */
export function contentWidth(): number {
  if (!process.stdout.isTTY) return Number.MAX_SAFE_INTEGER
  return Math.max(40, Math.min(process.stdout.columns ?? 80, MAX_COLUMNS) - GUTTER.length * 2)
}

/** Past this, a wide terminal only spreads a screen out: the eye loses the end of the line. */
export const MAX_COLUMNS = 104

export function visibleWidth(text: string): number {
  return Bun.stringWidth(text)
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)))
}

/** Breaks plain text into lines no wider than `width`, at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(" ")) {
      if (line === "") {
        line = word
      } else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
        line += ` ${word}`
      } else {
        lines.push(line)
        line = word
      }
      while (visibleWidth(line) > width) {
        lines.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    lines.push(line)
  }
  return lines
}

/** Wraps plain text and styles each line, so color never spans a line break. */
export function paragraph(
  text: string,
  style: (line: string) => string = (line) => line,
  width = contentWidth()
): string {
  return wrap(text, width).map(style).join("\n")
}

let commandPath = ""

/** Names the command that is running, for screens that open with it. Set once, at startup. */
export function setCommandPath(path: readonly string[]): void {
  commandPath = path.join(" ")
}

/**
 * The line that opens every screen: the mark, then what ran, then where, then how it stands.
 * Without a command, the one that is running.
 *
 *   ▰ sixb check  northline
 *   ▰ sixb worker-group  northline  ● running
 */
export function header(command?: string, context?: string, state?: string): string {
  const name = command ?? commandPath
  const title = name ? `${tone.strong("sixb")} ${name}` : tone.strong("sixb")
  return `${tone.blue(glyph.mark)} ${title}${context ? `  ${tone.muted(context)}` : ""}${state ? `  ${state}` : ""}`
}

export type Status = "ok" | "warn" | "fail" | "live" | "idle" | "pending"

export function statusGlyph(status: Status): string {
  switch (status) {
    case "ok":
      return tone.ok(glyph.ok)
    case "warn":
      return tone.warn(glyph.warn)
    case "fail":
      return tone.fail(glyph.fail)
    case "live":
      return tone.blue(glyph.live)
    case "idle":
      return tone.faint(glyph.idle)
    case "pending":
      return tone.faint(glyph.dot)
  }
}

/** A result's headline: a status mark, a sentence, a quieter aside, and where it landed. */
export function headline(status: Status, text: string, detail?: string, target?: string): string {
  const styled =
    status === "fail" ? paint(text, { color: palette.red, bold: true }) : tone.strong(text)
  return `${statusGlyph(status)} ${styled}${detail ? tone.muted(` ${glyph.dot} ${detail}`) : ""}${target ? tone.faint(`  ${glyph.arrow} ${target}`) : ""}`
}

/** What to do about a problem, in prose: led by an arrow, never colored like a command. */
export function remedy(text: string): string {
  return `${tone.faint(glyph.arrow)} ${text}`
}

export interface Row {
  readonly label: string
  readonly value: string
  readonly status?: Status
  /** Dimmer lines under the value, such as a remedy or a path. */
  readonly notes?: readonly string[]
  readonly noteStyle?: (text: string) => string
}

/**
 * Labels in a column and values beside them. A value wraps under itself, never under the label.
 *
 *   ✓ Storage     SqliteStorage · schema current
 *     Project     11 object types
 */
export function rows(
  items: readonly Row[],
  options: {
    readonly labelWidth?: number
    readonly labelStyle?: (text: string) => string
    readonly valueStyle?: (text: string) => string
  } = {}
): string {
  const labelStyle = options.labelStyle ?? tone.muted
  const valueStyle = options.valueStyle ?? ((text: string) => text)
  const hasStatus = items.some((item) => item.status)
  const labelWidth =
    Math.max(options.labelWidth ?? 0, ...items.map((item) => visibleWidth(item.label))) + 2
  const lead = hasStatus ? 2 : 0
  const valueWidth = Math.max(20, contentWidth() - lead - labelWidth)
  const hanging = " ".repeat(lead + labelWidth)

  return items
    .map((item) => {
      const mark = hasStatus ? `${item.status ? statusGlyph(item.status) : " "} ` : ""
      const label = labelStyle(pad(item.label, labelWidth))
      const valueLines = isUrl(item.value)
        ? [tone.url(item.value)]
        : wrap(item.value, valueWidth).map((line) =>
            item.status === "fail" ? tone.fail(line) : valueStyle(line)
          )
      const noteStyle = item.noteStyle ?? tone.muted
      const noteLines = (item.notes ?? []).flatMap((note) =>
        wrap(note, valueWidth - 2).map((line, index) =>
          item.noteStyle === remedy ? (index === 0 ? remedy(line) : `  ${line}`) : noteStyle(line)
        )
      )
      const [first = "", ...rest] = [...valueLines, ...noteLines]
      return [`${mark}${label}${first}`, ...rest.map((line) => `${hanging}${line}`)].join("\n")
    })
    .join("\n")
}

/** A quiet heading over a group of lines: the content carries the weight, not the label. */
export function section(title: string, body: string): string {
  return `${tone.muted(title)}\n${body}`
}

/** Columns sized to their widest cell, the header in quiet type, no rules. */
export function table(headers: readonly string[], cells: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(visibleWidth(header), ...cells.map((row) => visibleWidth(row[index] ?? "")))
  )
  const line = (values: readonly string[], style: (text: string, index: number) => string) =>
    values
      .map((value, index) =>
        index === values.length - 1
          ? style(value, index)
          : style(pad(value, widths[index] ?? 0), index)
      )
      .join("  ")
      .trimEnd()
  return [
    line(headers, (text) => tone.faint(text)),
    ...cells.map((row) => line(row, (text) => text)),
  ].join("\n")
}

/** Warnings, each wrapped under its own mark. */
export function warnings(items: readonly string[]): string | null {
  if (items.length === 0) return null
  return items.map((item) => marked(tone.warn(glyph.warn), item, tone.muted)).join("\n")
}

/** A line led by a one-cell mark, wrapped so the text keeps its column. */
export function marked(
  mark: string,
  text: string,
  style: (line: string) => string = (line) => line
): string {
  const [first = "", ...rest] = wrap(text, contentWidth() - 2)
  return [`${mark} ${style(first)}`, ...rest.map((line) => `  ${style(line)}`)].join("\n")
}

/** Command lines to run, as the next thing to do. */
export function commands(lines: readonly string[]): string {
  return lines.map((line) => `${tone.faint("$")} ${tone.blue(line)}`).join("\n")
}

/** Verbatim output, such as a build log, set off by a rule. */
export function quoted(lines: readonly string[], limit = 40): string {
  const shown = lines.length > limit ? lines.slice(-limit) : lines
  const width = contentWidth() - 2
  const body = shown.flatMap((line) =>
    wrap(Bun.stripANSI(line), width).map((part) => `${tone.faint(glyph.rule)} ${tone.muted(part)}`)
  )
  if (shown.length < lines.length) {
    body.unshift(tone.faint(`${glyph.rule} … ${lines.length - shown.length} earlier lines`))
  }
  return body.join("\n")
}

/** Key hints at the foot of a long-running screen: `ctrl+c stop`. */
export function hints(items: readonly (readonly [string, string])[]): string {
  return items
    .map(([key, label]) => `${tone.strong(key)} ${tone.muted(label)}`)
    .join(tone.faint(`  ${glyph.dot}  `))
}

export function isUrl(value: string): boolean {
  return /^(https?|wss?):\/\/\S+$/.test(value)
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}
