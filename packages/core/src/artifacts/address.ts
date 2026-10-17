import { isArtifactId } from "./ids"

/**
 * An address to an artifact, or to a part of one:
 *
 * ```text
 * artifact:<id>[@<version>][/<file>][#<part>]
 * ```
 *
 * Without a version it follows the latest one. What a part names depends on the target's kind: a
 * sheet (`Summary`), a range of one (`Summary!A1:D12`), a chart (`chart=revenue`), a document's
 * section by its slug (`methodology`), or a slide (`4`).
 */
export interface ArtifactAddress {
  readonly artifactId: string
  readonly version?: number
  /** A file inside the artifact, by its path. */
  readonly path?: string
  readonly part?: string
}

const SCHEME = "artifact:"

/** Whether a URL is written in the `artifact:` scheme, well formed or not. */
export function isArtifactAddress(value: string): boolean {
  return value.trim().toLowerCase().startsWith(SCHEME)
}

/** Reads an address; `null` when it is not a well-formed `artifact:` address. */
export function parseArtifactAddress(value: string): ArtifactAddress | null {
  const text = value.trim()
  if (!isArtifactAddress(text)) return null
  const hashAt = text.indexOf("#")
  const head = text.slice(SCHEME.length, hashAt === -1 ? undefined : hashAt)
  const part = hashAt === -1 ? undefined : decode(text.slice(hashAt + 1))
  const slashAt = head.indexOf("/")
  const target = slashAt === -1 ? head : head.slice(0, slashAt)
  const path = slashAt === -1 ? undefined : decodePath(head.slice(slashAt + 1))
  const [artifactId = "", version, ...rest] = target.split("@")
  if (!isArtifactId(artifactId) || rest.length > 0) return null
  if (version !== undefined && !/^[1-9]\d{0,8}$/.test(version)) return null
  if (path === null || part === null || part === "") return null
  return {
    artifactId,
    ...(version === undefined ? {} : { version: Number(version) }),
    ...(path === undefined ? {} : { path }),
    ...(part === undefined ? {} : { part }),
  }
}

/**
 * Writes an address so it survives inside Markdown: spaces and the characters that end a link
 * are escaped, and the rest of a part stays readable (`Q3%20numbers!A1:D12`).
 */
export function formatArtifactAddress(address: ArtifactAddress): string {
  const escaped = (text: string) =>
    encodeURI(text).replace(
      /[#()[\]<>]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    )
  return [
    SCHEME,
    address.artifactId,
    address.version === undefined ? "" : `@${address.version}`,
    address.path === undefined ? "" : `/${address.path.split("/").map(escaped).join("/")}`,
    address.part === undefined ? "" : `#${escaped(address.part)}`,
  ].join("")
}

/** A rectangle of cells, zero-based, where row 0 is the header row (`A1`). */
export interface CellRange {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

/** What a part names in a sheet: a sheet, a range of one, or a chart. */
export type SheetPart =
  | { readonly type: "sheet"; readonly sheet: string; readonly range?: CellRange }
  | { readonly type: "chart"; readonly chart: string }

/** Reads a sheet part: `chart=revenue`, `Summary`, or `Summary!A1:D12`. */
export function parseSheetPart(part: string): SheetPart | null {
  if (part.startsWith("chart=")) {
    const chart = part.slice("chart=".length)
    return chart ? { type: "chart", chart } : null
  }
  const bangAt = part.lastIndexOf("!")
  if (bangAt === -1) return { type: "sheet", sheet: part }
  const sheet = part.slice(0, bangAt)
  const range = parseCellRange(part.slice(bangAt + 1))
  return sheet && range ? { type: "sheet", sheet, range } : null
}

/** Reads `B2` or `A1:D12`, in either corner order. */
export function parseCellRange(text: string): CellRange | null {
  const corners = text.split(":")
  if (corners.length > 2) return null
  const cells = corners.map(parseCell)
  const [start, end = start] = cells
  if (!start || !end) return null
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  }
}

function parseCell(text: string): { readonly row: number; readonly column: number } | null {
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/.exec(text.trim())
  if (!match?.[1] || !match[2]) return null
  let column = 0
  for (const letter of match[1].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
  return { row: Number(match[2]) - 1, column: column - 1 }
}

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/** A relative file path: no empty, `.`, or `..` segment. */
function decodePath(text: string): string | null {
  const segments = text.split("/").map(decode)
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null
  return segments.join("/")
}
