import Papa from "papaparse"
import { en } from "../i18n/en"
import type { AgentDocumentKind } from "./types"

// Keep the DOM bounded; larger files remain available through the viewer's download action.
export const MAX_DELIMITED_PREVIEW_ROWS = 500
export const MAX_DELIMITED_PREVIEW_COLUMNS = 50

export interface DelimitedTextPreview {
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly totalRows: number
  readonly totalColumns: number
  readonly rowsTruncated: boolean
  readonly columnsTruncated: boolean
}

/** `reason` lets the viewer explain the failure in the reader's language. */
export class DelimitedTextParseError extends Error {
  constructor(
    message: string,
    readonly reason: "empty" | "malformed" | "no-header",
    readonly row?: number
  ) {
    super(message)
    this.name = "DelimitedTextParseError"
  }
}

export function parseDelimitedText(
  source: string,
  kind: Extract<AgentDocumentKind, "csv" | "tsv">,
  columnLabel: (index: number) => string = en.documents.column
): DelimitedTextPreview {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source
  if (!normalized.trim()) {
    throw new DelimitedTextParseError("The file is empty.", "empty")
  }

  let headerRecord: string[] | null = null
  let pendingRecord: string[] | null = null
  let parseError: DelimitedTextParseError | null = null
  let totalRows = 0
  let totalColumns = 0
  const previewRows: string[][] = []

  const retainRecord = (record: string[]) => {
    totalRows += 1
    totalColumns = Math.max(totalColumns, record.length)
    if (previewRows.length < MAX_DELIMITED_PREVIEW_ROWS) {
      previewRows.push(record.slice(0, MAX_DELIMITED_PREVIEW_COLUMNS))
    }
  }

  Papa.parse<string[]>(normalized, {
    delimiter: kind === "tsv" ? "\t" : ",",
    skipEmptyLines: false,
    step: (result, parser) => {
      const error = result.errors[0]
      if (error) {
        const row = error.row === undefined ? undefined : totalRows + 2
        parseError = new DelimitedTextParseError(
          `The file contains malformed delimited text${row === undefined ? "" : ` near row ${row}`}.`,
          "malformed",
          row
        )
        parser.abort()
        return
      }

      const record = result.data
      if (headerRecord === null) {
        headerRecord = record.slice(0, MAX_DELIMITED_PREVIEW_COLUMNS)
        totalColumns = record.length
        return
      }

      // Hold one row back so a parser-generated empty record from a terminal line break can be
      // discarded without retaining every row in memory.
      if (pendingRecord !== null) retainRecord(pendingRecord)
      pendingRecord = record
    },
  })

  if (parseError) throw parseError
  if (headerRecord === null) {
    throw new DelimitedTextParseError("The file does not contain a header row.", "no-header")
  }
  if (pendingRecord && !(endsWithLineBreak(normalized) && isEmptyRecord(pendingRecord))) {
    retainRecord(pendingRecord)
  }

  const renderedColumns = Math.min(totalColumns, MAX_DELIMITED_PREVIEW_COLUMNS)
  const headers = Array.from({ length: renderedColumns }, (_, index) => {
    const value = headerRecord?.[index]?.trim()
    return value || columnLabel(index + 1)
  })
  const rows = previewRows.map((record) =>
    Array.from({ length: renderedColumns }, (_, index) => record[index] ?? "")
  )

  return {
    headers,
    rows,
    totalRows,
    totalColumns,
    rowsTruncated: totalRows > rows.length,
    columnsTruncated: totalColumns > headers.length,
  }
}

function endsWithLineBreak(value: string): boolean {
  return value.endsWith("\n") || value.endsWith("\r")
}

function isEmptyRecord(record: readonly string[]): boolean {
  return record.every((value) => value === "")
}
