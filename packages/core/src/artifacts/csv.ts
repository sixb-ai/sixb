/**
 * The one CSV reader for sheets, used when a sheet is published and when it is shown, so both read
 * the same cells. RFC 4180: fields split on commas (or tabs); a quoted field may hold separators,
 * line breaks, and doubled quotes; lines end in CRLF, LF, or CR; a leading byte-order mark is not
 * part of the text; blank lines are skipped. Rows come back as they were written, some shorter or
 * longer than the header: the reader of the table decides what that means.
 */
export interface CsvTable {
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

export class CsvParseError extends Error {
  constructor(
    message: string,
    /** The line, from 1, where the record that could not be read starts. */
    readonly line: number
  ) {
    super(message)
    this.name = "CsvParseError"
  }
}

export function parseCsv(
  text: string,
  options: { readonly delimiter?: "," | "\t" } = {}
): CsvTable {
  const delimiter = options.delimiter ?? ","
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ""
  // Inside a quoted field; and whether the current record had one, so `""` alone is a record.
  let quoted = false
  let quotedSeen = false
  let line = 1
  let recordLine = 1
  let index = 0

  const endField = () => {
    record.push(field)
    field = ""
  }
  const endRecord = () => {
    endField()
    // A line with nothing on it is not a record.
    if (!(record.length === 1 && record[0] === "" && !quotedSeen)) records.push(record)
    record = []
    quotedSeen = false
  }

  while (index < source.length) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        const next = source[index]
        if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
          throw new CsvParseError(
            `A quoted field on line ${line} goes on after its closing quote; quote the whole field and double the quotes inside it.`,
            recordLine
          )
        }
        continue
      }
      if (char === "\n" || (char === "\r" && source[index + 1] !== "\n")) line += 1
      field += char
      index += 1
      continue
    }
    if (char === '"' && field === "") {
      quoted = true
      quotedSeen = true
      index += 1
      continue
    }
    if (char === delimiter) {
      endField()
      index += 1
      continue
    }
    if (char === "\r" || char === "\n") {
      endRecord()
      index += char === "\r" && source[index + 1] === "\n" ? 2 : 1
      line += 1
      recordLine = line
      continue
    }
    field += char
    index += 1
  }
  if (quoted) {
    throw new CsvParseError(
      `A quoted field that starts on line ${recordLine} is never closed.`,
      recordLine
    )
  }
  if (field !== "" || record.length > 0 || quotedSeen) endRecord()

  const [header, ...rows] = records
  return { header: header ?? [], rows }
}
