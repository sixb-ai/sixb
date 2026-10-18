import { formatFileSize } from "./file-size"
import type { ArtifactMessages } from "./messages"
import type { ArtifactVersion } from "./queries"

/**
 * What a card says about a version beside its title, from what publishing read: a workbook's
 * sheets and charts, a document's sections, a deck's slides, or a file's format and size.
 */
export function versionSummary(
  version: ArtifactVersion,
  messages: ArtifactMessages,
  locale: string
): string {
  const { outline } = version
  const details: string[] = []
  switch (outline.kind) {
    case "sheet": {
      const [only] = outline.sheets
      details.push(
        outline.sheets.length === 1 && only
          ? messages.card.rows(only.rows)
          : messages.card.sheets(outline.sheets.length)
      )
      if (outline.charts.length > 0) details.push(messages.card.charts(outline.charts.length))
      break
    }
    case "document": {
      const sections = outline.headings.filter((heading) => heading.depth === 2).length
      if (sections > 0) details.push(messages.card.sections(sections))
      break
    }
    case "slides":
      details.push(messages.card.slides(outline.slides.length))
      break
    case "file": {
      // A file reads as its format, which says more than "File".
      const file = version.files.find((candidate) => candidate.path === version.entry)
      const format = fileExtension(version.entry)?.toUpperCase()
      return [
        format ?? messages.kinds.file,
        ...(file ? [formatFileSize(file.file.sizeBytes, locale, messages.files)] : []),
      ].join(" · ")
    }
  }
  return [messages.kinds[outline.kind], ...details].join(" · ")
}

/** A file name's extension, lowercased, when it has one short enough to name a format. */
export function fileExtension(name: string): string | undefined {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase()
}

/**
 * What a version changed in its artifact's structure: the sheets, charts, or sections it added and
 * removed. Edits within them leave no trace in the structure, so they say nothing here.
 */
export function versionChanges(
  previous: ArtifactVersion,
  current: ArtifactVersion,
  messages: ArtifactMessages
): string[] {
  const { card } = messages
  const before = previous.outline
  const after = current.outline
  const changes: string[] = []
  const compare = (
    earlier: readonly string[],
    later: readonly string[],
    added: (count: number) => string,
    removed: (count: number) => string,
    named: boolean
  ) => {
    const gone = earlier.filter((name) => !later.includes(name))
    const fresh = later.filter((name) => !earlier.includes(name))
    if (fresh.length > 0) {
      changes.push(named && fresh.length === 1 ? card.added(fresh[0] ?? "") : added(fresh.length))
    }
    if (gone.length > 0) {
      changes.push(named && gone.length === 1 ? card.removed(gone[0] ?? "") : removed(gone.length))
    }
  }
  if (before.kind === "sheet" && after.kind === "sheet") {
    const names = (outline: typeof before) => outline.sheets.map((sheet) => sheet.name)
    compare(names(before), names(after), card.addedSheets, card.removedSheets, true)
    compare(before.charts, after.charts, card.addedCharts, card.removedCharts, false)
  } else if (before.kind === "document" && after.kind === "document") {
    const sections = (outline: typeof before) =>
      outline.headings.filter((heading) => heading.depth === 2).map((heading) => heading.text)
    compare(sections(before), sections(after), card.addedSections, card.removedSections, true)
  }
  return changes
}
