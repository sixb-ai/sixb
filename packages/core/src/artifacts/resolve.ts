import { type ArtifactAddress, type CellRange, parseSheetPart } from "./address"
import type { ArtifactKind } from "./kinds"
import type { ArtifactOutline } from "./outline"

/** The version an address points into: its kind, its outline, and its file list. */
export interface ArtifactAddressTarget {
  readonly kind: ArtifactKind
  readonly outline: ArtifactOutline
  readonly files: readonly { readonly path: string }[]
}

/** What an address names inside its target. */
export type ResolvedArtifactPart =
  | { readonly type: "artifact" }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "sheet"; readonly sheet: string; readonly range?: CellRange }
  | { readonly type: "chart"; readonly chart: string }
  | { readonly type: "section"; readonly slug: string }
  | { readonly type: "slide"; readonly slide: number }
  | { readonly type: "board"; readonly id: string }
  | { readonly type: "region"; readonly id: string }

/**
 * Finds what an address names in a version, against its outline and files. A problem says what is
 * missing and what the version has instead, so whoever wrote the address can fix it.
 */
export function resolveArtifactAddress(
  address: ArtifactAddress,
  target: ArtifactAddressTarget
): { readonly part: ResolvedArtifactPart } | { readonly problem: string } {
  if (address.path !== undefined) {
    if (address.part !== undefined) return { problem: "names both a file and a part of one" }
    return target.files.some((file) => file.path === address.path)
      ? { part: { type: "file", path: address.path } }
      : { problem: `has no file '${address.path}'` }
  }
  if (address.part === undefined) return { part: { type: "artifact" } }

  const { outline } = target
  switch (outline.kind) {
    case "sheet": {
      const part = parseSheetPart(address.part)
      if (!part) {
        return {
          problem: `has no part '${address.part}': name a sheet, a range such as Summary!A1:D12, or chart=<name>`,
        }
      }
      if (part.type === "chart") {
        return outline.charts.includes(part.chart)
          ? { part }
          : { problem: `has no chart '${part.chart}'${listed("its charts", outline.charts)}` }
      }
      const sheet = outline.sheets.find((candidate) => candidate.name === part.sheet)
      if (!sheet) {
        return {
          problem: `has no sheet '${part.sheet}'${listed(
            "its sheets",
            outline.sheets.map((candidate) => candidate.name)
          )}`,
        }
      }
      // Row 1 is the header row, so the last row is one past the data rows.
      if (
        part.range &&
        (part.range.bottom > sheet.rows || part.range.right >= sheet.columns.length)
      ) {
        return {
          problem: `has no range ${address.part.slice(address.part.lastIndexOf("!") + 1)} in sheet '${sheet.name}', which has ${sheet.rows + 1} rows and ${sheet.columns.length} columns`,
        }
      }
      return { part }
    }
    case "document": {
      const heading = outline.headings.find((candidate) => candidate.slug === address.part)
      return heading
        ? { part: { type: "section", slug: heading.slug } }
        : {
            problem: `has no section '${address.part}'${listed(
              "its sections",
              outline.headings.map((candidate) => candidate.slug)
            )}`,
          }
    }
    case "slides": {
      const slide = /^[1-9]\d*$/.test(address.part) ? Number(address.part) : Number.NaN
      return slide <= outline.slides.length
        ? { part: { type: "slide", slide } }
        : { problem: `has no slide '${address.part}': it has ${outline.slides.length} slides` }
    }
    case "canvas": {
      // A canvas names its boards and its sections, which are regions of it.
      const item = outline.items.find((candidate) => candidate.id === address.part)
      if (!item) {
        return {
          problem: `has no board or section '${address.part}'${listed(
            "its boards and sections",
            outline.items.map((candidate) => candidate.id)
          )}`,
        }
      }
      return { part: { type: item.type === "board" ? "board" : "region", id: item.id } }
    }
    case "page":
    case "file":
      return { problem: `is a ${target.kind}, which has no parts to name` }
  }
}

function listed(label: string, names: readonly string[]): string {
  if (names.length === 0) return ""
  const shown = names.slice(0, 8).map((name) => `'${name}'`)
  return `; ${label} are ${shown.join(", ")}${names.length > shown.length ? ", …" : ""}`
}
