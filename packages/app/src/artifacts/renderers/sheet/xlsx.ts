import {
  FORMULA_ERRORS,
  type FormulaNode,
  isArtifactAddress,
  parseFormula,
  parseSheetDate,
  parseSheetNumber,
  type SheetTotal,
} from "@sixb/core/artifacts"
import { currencySymbol } from "./format"
import type { SheetColumn, SheetModel } from "./model"
import { columnLetter } from "./selection"
import { columnTotals } from "./totals"
import { zipFiles } from "./zip"

export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * A workbook as an `.xlsx` file: one worksheet per sheet, in order, with the header row bold, each
 * column's values typed and in its format (grouped or compact numbers, the currency's sign, signs on
 * signed columns, percents, dates), links that open, the frozen rows and columns, the column widths
 * the grid shows, booleans as TRUE and FALSE, highlights as conditional formats, and the totals
 * row as formulas.
 */
export async function workbookXlsx(sheets: readonly SheetModel[]): Promise<Uint8Array> {
  const styles = new StyleSheet()
  const names = sheetNames(sheets.map((sheet) => sheet.name))
  const files: { path: string; text: string }[] = []

  sheets.forEach((sheet, index) => {
    const { xml, links } = worksheet(sheet, styles)
    files.push({ path: `xl/worksheets/sheet${index + 1}.xml`, text: xml })
    if (links.length > 0) {
      files.push({
        path: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
        text: relationships(
          links.map((target, link) => ({
            id: `rId${link + 1}`,
            type: `${RELATIONSHIPS}/hyperlink`,
            target,
            external: true,
          }))
        ),
      })
    }
  })

  files.push(
    {
      path: "[Content_Types].xml",
      text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("")}</Types>`,
    },
    {
      path: "_rels/.rels",
      text: relationships([
        { id: "rId1", type: `${RELATIONSHIPS}/officeDocument`, target: "xl/workbook.xml" },
      ]),
    },
    {
      path: "xl/workbook.xml",
      text: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets>${names
        .map(
          (name, index) =>
            `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        )
        .join("")}</sheets></workbook>`,
    },
    {
      path: "xl/_rels/workbook.xml.rels",
      text: relationships([
        ...sheets.map((_, index) => ({
          id: `rId${index + 1}`,
          type: `${RELATIONSHIPS}/worksheet`,
          target: `worksheets/sheet${index + 1}.xml`,
        })),
        { id: `rId${sheets.length + 1}`, type: `${RELATIONSHIPS}/styles`, target: "styles.xml" },
      ]),
    },
    { path: "xl/styles.xml", text: styles.xml() }
  )

  const encoder = new TextEncoder()
  return zipFiles(files.map((file) => ({ path: file.path, data: encoder.encode(file.text) })))
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
/** Days from Excel's day zero, 1899-12-30, to 1970-01-01. */
const EPOCH_SERIAL = 25569
const DAY_MS = 24 * 60 * 60 * 1000

function worksheet(
  sheet: SheetModel,
  styles: StyleSheet
): { readonly xml: string; readonly links: readonly string[] } {
  const links: string[] = []
  const hyperlinks: string[] = []
  const header = sheet.columns
    .map(
      (column, index) =>
        `<c r="${columnLetter(index)}1" s="${HEADER_STYLE}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(column.name)}</t></is></c>`
    )
    .join("")
  const writers = sheet.columns.map((column) => cellWriter(column, styles))
  const letters = new Map(sheet.columns.map((column, index) => [column.name, columnLetter(index)]))
  const lastRow = sheet.rows.length + 1
  const formulas = sheet.columns.map((column) =>
    column.format.formula ? parseFormula(column.format.formula) : null
  )
  const rows = sheet.rows.map((values, rowIndex) => {
    const row = rowIndex + 2
    const cells = sheet.columns.map((column, index) => {
      const value = values[index] ?? ""
      const formula = formulas[index]
      if (formula) {
        const ref = `${columnLetter(index)}${row}`
        return computedCell(ref, formulaToA1(formula, letters, row, lastRow), value, column, styles)
      }
      if (!value.trim()) return ""
      const ref = `${columnLetter(index)}${row}`
      if (column.format.type === "link" && /^https?:\/\//i.test(value.trim())) {
        links.push(value.trim())
        hyperlinks.push(`<hyperlink ref="${ref}" r:id="rId${links.length}"/>`)
      }
      return writers[index]?.(ref, value) ?? ""
    })
    return `<row r="${row}">${cells.join("")}</row>`
  })
  const totals = totalsRow(sheet, styles)
  const shading = conditionalFormats(sheet)

  const xml = [
    XML,
    `<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">`,
    `<sheetViews><sheetView workbookViewId="0">${pane(sheet.frozenRows, sheet.frozenColumns)}</sheetView></sheetViews>`,
    `<cols>${sheet.columns
      .map(
        (column, index) =>
          `<col min="${index + 1}" max="${index + 1}" width="${characterWidth(column.width)}" customWidth="1"/>`
      )
      .join("")}</cols>`,
    `<sheetData><row r="1">${header}</row>${rows.join("")}${totals}</sheetData>`,
    shading,
    hyperlinks.length > 0 ? `<hyperlinks>${hyperlinks.join("")}</hyperlinks>` : "",
    "</worksheet>",
  ].join("")
  return { xml, links }
}

/**
 * Each highlighted column as Excel's conditional format over its data rows: a data bar, a scale
 * from white to gray, or a diverging scale with red below zero and green above, in Excel's own
 * colors for them.
 */
function conditionalFormats(sheet: SheetModel): string {
  if (sheet.rows.length === 0) return ""
  let priority = 0
  return sheet.columns
    .map((column, index) => {
      const highlight = column.format.highlight
      if (!highlight) return ""
      priority += 1
      const sqref = `${columnLetter(index)}2:${columnLetter(index)}${sheet.rows.length + 1}`
      const rule =
        highlight === "bars"
          ? '<dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF8EA9C1"/></dataBar>'
          : highlight === "scale"
            ? '<colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FFA6A6A6"/></colorScale>'
            : '<colorScale><cfvo type="min"/><cfvo type="num" val="0"/><cfvo type="max"/><color rgb="FFF8696B"/><color rgb="FFFFFFFF"/><color rgb="FF63BE7B"/></colorScale>'
      const type = highlight === "bars" ? "dataBar" : "colorScale"
      return `<conditionalFormatting sqref="${sqref}"><cfRule type="${type}" priority="${priority}">${rule}</cfRule></conditionalFormatting>`
    })
    .join("")
}

/**
 * A computed cell: its formula in A1 references, with the value the grid shows cached beside it,
 * typed as its column is, so a reader that does not recalculate shows the same.
 */
function computedCell(
  ref: string,
  formula: string,
  value: string,
  column: SheetColumn,
  styles: StyleSheet
): string {
  const f = `<f>${escapeXml(formula)}</f>`
  if ((FORMULA_ERRORS as readonly string[]).includes(value)) {
    return `<c r="${ref}" t="e">${f}<v>${value}</v></c>`
  }
  if (!value) return `<c r="${ref}">${f}</c>`
  switch (column.format.type) {
    case "number":
    case "currency":
    case "percent":
      return `<c r="${ref}" s="${styles.numberFormat(numberFormatCode(column))}">${f}<v>${value}</v></c>`
    case "date": {
      const date = parseSheetDate(value)
      return date
        ? `<c r="${ref}" s="${styles.numberFormat("yyyy-mm-dd")}">${f}<v>${date.getTime() / DAY_MS + EPOCH_SERIAL}</v></c>`
        : `<c r="${ref}">${f}</c>`
    }
    case "boolean":
      return `<c r="${ref}" t="b">${f}<v>${value === "true" ? 1 : 0}</v></c>`
    default:
      return `<c r="${ref}" t="str">${f}<v>${escapeXml(value)}</v></c>`
  }
}

/** Functions newer than Excel 2010, which a file names with Excel's `_xlfn.` prefix. */
const FUTURE_FUNCTIONS = new Set(["CONCAT", "DAYS"])
/** How tightly each operator binds, as Excel reads them, for the parentheses a formula needs. */
const BINDING: Record<string, number> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
  "^": 5,
}

/**
 * A formula with its column references as A1 references in this row: `[@Revenue]` is `B5`, and a
 * whole column `[Revenue]` is its data rows, `$B$2:$B$13`. Parentheses are written where Excel's
 * precedence needs them.
 */
export function formulaToA1(
  node: FormulaNode,
  letters: ReadonlyMap<string, string>,
  row: number,
  lastRow: number
): string {
  const write = (current: FormulaNode): string => {
    switch (current.kind) {
      case "number":
        return String(current.value)
      case "text":
        return `"${current.value.replace(/"/g, '""')}"`
      case "boolean":
        return current.value ? "TRUE" : "FALSE"
      case "ref":
        return `${letters.get(current.column) ?? "A"}${row}`
      case "columnRef": {
        const letter = letters.get(current.column) ?? "A"
        return `$${letter}$2:$${letter}$${lastRow}`
      }
      case "unary": {
        const operand = write(current.operand)
        return `${current.op}${current.operand.kind === "binary" ? `(${operand})` : operand}`
      }
      case "binary": {
        const power = BINDING[current.op] ?? 0
        // Each side keeps its own grouping: a looser operator on the left, and an equal or
        // looser one on the right, since Excel reads left to right.
        const side = (child: FormulaNode, right: boolean) => {
          const text = write(child)
          if (child.kind !== "binary") return text
          const inner = BINDING[child.op] ?? 0
          return inner < power || (right && inner === power) ? `(${text})` : text
        }
        return `${side(current.left, false)}${current.op}${side(current.right, true)}`
      }
      case "call":
        return `${FUTURE_FUNCTIONS.has(current.name) ? "_xlfn." : ""}${current.name}(${current.args.map(write).join(",")})`
    }
  }
  return write(node)
}

/** Excel's SUBTOTAL function for each total, in the forms that pass rows a filter hides. */
const SUBTOTAL: Record<SheetTotal, number> = {
  average: 101,
  count: 103,
  max: 104,
  min: 105,
  sum: 109,
}

/**
 * The totals row under the data, bold: each total as a SUBTOTAL formula over its column, so a
 * filter in Excel keeps it right, with its value computed here for readers that do not
 * recalculate; "Total" in the first column without one.
 */
function totalsRow(sheet: SheetModel, styles: StyleSheet): string {
  if (!sheet.totals || sheet.rows.length === 0) return ""
  const row = sheet.rows.length + 2
  const totals = columnTotals(
    sheet,
    sheet.rows.map((_, index) => index)
  )
  const label = sheet.columns.findIndex((column) => !column.total)
  const cells = sheet.columns.map((column, index) => {
    const ref = `${columnLetter(index)}${row}`
    const entry = totals.get(index)
    if (!entry) {
      return index === label
        ? `<c r="${ref}" s="${HEADER_STYLE}" t="inlineStr"><is><t>Total</t></is></c>`
        : ""
    }
    // Excel would total the cells written empty: a total over what the reader may not see is left out.
    if (entry.locked) return ""
    const style = styles.numberFormat(
      entry.total === "count" ? "#,##0" : numberFormatCode(column),
      true
    )
    const range = `${columnLetter(index)}2:${columnLetter(index)}${row - 1}`
    const cached = entry.value === undefined ? "" : `<v>${entry.value}</v>`
    return `<c r="${ref}" s="${style}"><f>SUBTOTAL(${SUBTOTAL[entry.total]},${range})</f>${cached}</c>`
  })
  return `<row r="${row}">${cells.join("")}</row>`
}

/** How one column's cells are written: as typed values in its format, or as text. */
function cellWriter(
  column: SheetColumn,
  styles: StyleSheet
): (ref: string, value: string) => string {
  const text = (ref: string, value: string, style?: number) =>
    `<c r="${ref}"${style === undefined ? "" : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
  const { format } = column
  switch (format.type) {
    case "number":
    case "currency":
    case "percent": {
      const style = styles.numberFormat(numberFormatCode(column))
      return (ref, value) => {
        const number = parseSheetNumber(value)
        return number === undefined
          ? text(ref, value)
          : `<c r="${ref}" s="${style}"><v>${number}</v></c>`
      }
    }
    case "date": {
      const dateOnly = styles.numberFormat("yyyy-mm-dd")
      const dateTime = styles.numberFormat("yyyy-mm-dd hh:mm")
      return (ref, value) => {
        const date = parseSheetDate(value)
        if (!date) return text(ref, value)
        const withTime = value.trim().length > 10
        // A date-time reads in the reader's time, as the grid shows it; a date has no zone.
        const local = withTime ? date.getTime() - date.getTimezoneOffset() * 60_000 : date.getTime()
        const serial = local / DAY_MS + EPOCH_SERIAL
        return `<c r="${ref}" s="${withTime ? dateTime : dateOnly}"><v>${serial}</v></c>`
      }
    }
    case "link": {
      const style = styles.link()
      return (ref, value) =>
        isArtifactAddress(value.trim()) ? text(ref, value) : text(ref, value.trim(), style)
    }
    case "boolean":
      return (ref, value) => {
        const word = value.trim().toLowerCase()
        if (word !== "true" && word !== "false") return text(ref, value)
        return `<c r="${ref}" t="b"><v>${word === "true" ? 1 : 0}</v></c>`
      }
    case "image":
    case "text":
    case "tag":
      return (ref, value) => text(ref, value)
  }
}

/**
 * The Excel number format that matches how the grid shows a numeric column. A signed column
 * shows `+` on positive values in a section of its own. A compact one scales by thousands and
 * millions with Excel's two conditional sections, so a negative value shows in full; a column both
 * compact and signed shows signed and in full, since Excel's sections can't hold both.
 */
function numberFormatCode(column: SheetColumn): string {
  const { format } = column
  const digits = (count: number) => (count > 0 ? `.${"0".repeat(count)}` : "")
  const decimals = digits(column.decimals)
  const prefix =
    format.type === "currency"
      ? `"${currencySymbol(format.currency ?? "USD").replace(/"/g, "")}"`
      : ""
  const plain = format.type === "percent" ? `0${decimals}%` : `${prefix}#,##0${decimals}`
  if (format.signed) return `+${plain};-${plain};${plain}`
  if (format.compact) {
    const scaled = `${prefix}#,##0${digits(format.decimals ?? 1)}`
    return `[>=1000000]${scaled},,"M";[>=1000]${scaled},"K";${prefix}#,##0`
  }
  return plain
}

/** Frozen rows and columns as a split pane, so they stay in view as the sheet scrolls. */
function pane(rows: number, columns: number): string {
  if (rows === 0 && columns === 0) return ""
  const active = rows > 0 && columns > 0 ? "bottomRight" : rows > 0 ? "bottomLeft" : "topRight"
  return `<pane${columns > 0 ? ` xSplit="${columns}"` : ""}${rows > 0 ? ` ySplit="${rows}"` : ""} topLeftCell="${columnLetter(columns)}${rows + 1}" activePane="${active}" state="frozen"/>`
}

/** A width in pixels as Excel's, in characters of its default font. */
function characterWidth(pixels: number): number {
  return Math.round((Math.max(pixels - 5, 8) / 7) * 100) / 100
}

/**
 * Sheet names as Excel takes them: at most 31 characters, none of `[]:*?/\`, unique ignoring
 * case. A sheet's name in Sixb may be longer or hold those.
 */
function sheetNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name, index) => {
    const base =
      name
        .replace(/[[\]:*?/\\]/g, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, 31) || `Sheet${index + 1}`
    let candidate = base
    for (let repeat = 2; used.has(candidate.toLowerCase()); repeat += 1) {
      const suffix = ` (${repeat})`
      candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

function relationships(
  entries: readonly { id: string; type: string; target: string; external?: boolean }[]
): string {
  return `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${escapeXml(entry.target)}"${entry.external ? ' TargetMode="External"' : ""}/>`
    )
    .join("")}</Relationships>`
}

/** Text as XML takes it: escaped, without the control characters XML 1.0 refuses. */
function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Style 0 is the default, 1 the bold header and totals label; the rest are added as needed. */
const HEADER_STYLE = 1

class StyleSheet {
  /** Each number format's id, by its code. */
  private readonly formats = new Map<string, number>()
  /** Each style's index, by its format and weight. */
  private readonly styles = new Map<string, number>()
  private readonly cells: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  ]
  private linkStyle: number | undefined

  /** The style for a number format, bold or not; custom formats are numbered from 164, as Excel's. */
  numberFormat(code: string, bold = false): number {
    const key = `${bold ? "b" : ""}\u0000${code}`
    const known = this.styles.get(key)
    if (known !== undefined) return known
    let id = this.formats.get(code)
    if (id === undefined) {
      id = 164 + this.formats.size
      this.formats.set(code, id)
    }
    const style = this.cells.length
    this.cells.push(
      `<xf numFmtId="${id}" fontId="${bold ? 1 : 0}" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"${bold ? ' applyFont="1"' : ""}/>`
    )
    this.styles.set(key, style)
    return style
  }

  link(): number {
    if (this.linkStyle === undefined) {
      this.linkStyle = this.cells.length
      this.cells.push(
        '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
      )
    }
    return this.linkStyle
  }

  xml(): string {
    const formats = Array.from(this.formats)
      .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`)
      .join("")
    return [
      XML,
      `<styleSheet xmlns="${MAIN}">`,
      formats ? `<numFmts count="${this.formats.size}">${formats}</numFmts>` : "",
      '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>',
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
      `<cellXfs count="${this.cells.length}">${this.cells.join("")}</cellXfs>`,
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
      "</styleSheet>",
    ].join("")
  }
}
