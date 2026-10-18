import { isArtifactAddress, parseSheetDate, parseSheetNumber } from "@sixb/core/artifacts"
import { currencySymbol } from "./format"
import type { SheetColumn, SheetModel } from "./model"
import { columnLetter } from "./selection"
import { zipFiles } from "./zip"

export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * A workbook as an `.xlsx` file: one worksheet per sheet, in order, with the header row bold, each
 * column's values typed and in its format (grouped numbers, the currency's sign, percents, dates),
 * links that open, the frozen rows and columns, and the column widths the grid shows.
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
  const rows = sheet.rows.map((values, rowIndex) => {
    const row = rowIndex + 2
    const cells = sheet.columns.map((column, index) => {
      const value = values[index] ?? ""
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
    `<sheetData><row r="1">${header}</row>${rows.join("")}</sheetData>`,
    hyperlinks.length > 0 ? `<hyperlinks>${hyperlinks.join("")}</hyperlinks>` : "",
    "</worksheet>",
  ].join("")
  return { xml, links }
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
    case "image":
    case "text":
      return (ref, value) => text(ref, value)
  }
}

/** The Excel number format that matches how the grid shows a numeric column. */
function numberFormatCode(column: SheetColumn): string {
  const decimals = column.decimals > 0 ? `.${"0".repeat(column.decimals)}` : ""
  switch (column.format.type) {
    case "percent":
      return `0${decimals}%`
    case "currency": {
      const sign = currencySymbol(column.format.currency ?? "USD")
      return `"${sign.replace(/"/g, "")}"#,##0${decimals}`
    }
    default:
      return `#,##0${decimals}`
  }
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

/** Style 0 is the default, 1 the bold header; the rest are added as the columns need them. */
const HEADER_STYLE = 1

class StyleSheet {
  private readonly formats = new Map<string, number>()
  private readonly cells: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  ]
  private linkStyle: number | undefined

  /** The style for a number format; custom formats are numbered from 164, as Excel's are. */
  numberFormat(code: string): number {
    const known = this.formats.get(code)
    if (known !== undefined) return known
    const style = this.cells.length
    const id = 164 + this.formats.size
    this.cells.push(
      `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
    )
    this.formats.set(code, style)
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
    const formats = Array.from(this.formats.keys())
      .map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${escapeXml(code)}"/>`)
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
