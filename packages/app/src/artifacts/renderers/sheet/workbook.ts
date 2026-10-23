import type { GetArtifactQueryResponse } from "@sixb/client"
import {
  ARTIFACT_LIMITS,
  type CsvTable,
  liveSheetColumns,
  liveSheetTable,
  parseCsv,
  parseWorkbook,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookSheet,
} from "@sixb/core/artifacts"
import type { QueryClient } from "@tanstack/react-query"
import { useMemo } from "react"
import type { FileSource } from "../../file-source"
import type { ArtifactMessages } from "../../messages"
import {
  type ArtifactQueryError,
  type ArtifactVersion,
  fetchArtifactQuery,
  fetchFileText,
  useArtifactQuery,
  useFileText,
  versionFileSource,
} from "../../queries"
import { type SheetModel, sheetModel } from "./model"

/**
 * A sheet artifact's `workbook.json`, parsed once it is read: undefined until then, and null when
 * it cannot be read or does not parse.
 */
export function useWorkbook(version: ArtifactVersion): {
  readonly workbook: Workbook | null | undefined
  readonly loading: boolean
} {
  const file = useFileText(versionFileSource(version, WORKBOOK_FILE))
  const workbook = useMemo(() => {
    if (file.text === undefined) return file.loading ? undefined : null
    const parsed = parseWorkbook(file.text)
    return "workbook" in parsed ? parsed.workbook : null
  }, [file.text, file.loading])
  return { workbook, loading: file.loading }
}

/**
 * One sheet of a workbook, read whole from its CSV and laid out as the workbook says. Publishing
 * caps a sheet's file at what the viewer reads; one over it is `tooLarge`, to download instead.
 * A live sheet's rows are its query's, read as the signed-in reader: `error` says why there are
 * none to show, rather than a sheet of no rows.
 */
export function useSheetModel(
  version: ArtifactVersion,
  sheet: WorkbookSheet | undefined
): {
  readonly model: SheetModel | null
  /** The sheet's values as its CSV holds them, computed columns empty: what an edit starts from. */
  readonly table: CsvTable | null
  /** The sheet's CSV, which downloads as it is; none for a live sheet. */
  readonly source: FileSource | null
  readonly loading: boolean
  readonly tooLarge: boolean
  /** Why a live sheet's rows could not be read. */
  readonly error: ArtifactQueryError | null
} {
  const live = sheet?.live
  const source = sheet && !live ? versionFileSource(version, sheetFilePath(sheet.name)) : null
  const csv = useFileText(source, ARTIFACT_LIMITS.maxSheetFileBytes)
  const query = useArtifactQuery(version, live?.query ?? null)

  const read = useMemo(() => {
    if (!sheet) return null
    if (live) return query.result ? liveModel(sheet, query.result) : null
    if (csv.text === undefined) return null
    try {
      const table = parseCsv(csv.text)
      return { table, model: sheetModel(sheet, table) }
    } catch {
      return null
    }
  }, [sheet, live, csv.text, query.result])

  return {
    model: read?.model ?? null,
    table: read?.table ?? null,
    source,
    loading: live ? query.loading : csv.loading,
    tooLarge: csv.tooLarge,
    error: live
      ? (query.error ?? (query.result && !read ? { kind: "failed" as const } : null))
      : null,
  }
}

/** Why a live sheet shows no rows, in the viewer's words: never a sheet that reads as empty. */
export function liveSheetErrorText(
  error: ArtifactQueryError,
  messages: ArtifactMessages["sheet"]
): { readonly title: string; readonly description?: string } {
  switch (error.kind) {
    case "forbidden":
      return { title: messages.queryForbidden }
    case "invalid":
      return {
        title: messages.queryInvalid,
        ...(error.reason ? { description: error.reason } : {}),
      }
    case "failed":
      return { title: messages.queryFailed }
  }
}

/**
 * A live sheet laid out against its query's rows as the reader reads them. A query that no longer
 * returns rows, which publishing refused, lays nothing out.
 */
function liveModel(
  sheet: WorkbookSheet,
  result: GetArtifactQueryResponse
): { readonly table: CsvTable; readonly model: SheetModel } | null {
  if (result.kind !== "objects") return null

  const layout = liveSheetColumns(sheet, result.schema)
  const { table, locked } = liveSheetTable(layout, result.objects)
  return { table, model: sheetModel(layout.sheet, table, { locked, truncated: result.truncated }) }
}

/**
 * Every sheet of a workbook, read and laid out, in its order: for a download of the whole
 * workbook. Sheets the reader opened come from the cache.
 */
export async function readWorkbookModels(
  client: QueryClient,
  version: ArtifactVersion,
  workbook: Workbook
): Promise<SheetModel[]> {
  return Promise.all(workbook.sheets.map((sheet) => readSheetModel(client, version, sheet)))
}

/** One sheet, read and laid out, its computed columns filled; a live sheet's from its query. */
export async function readSheetModel(
  client: QueryClient,
  version: ArtifactVersion,
  sheet: WorkbookSheet
): Promise<SheetModel> {
  if (sheet.live) {
    const read = liveModel(sheet, await fetchArtifactQuery(client, version, sheet.live.query))
    if (!read) throw new Error(`[SixbApp] Sheet '${sheet.name}' reads no rows.`)
    return read.model
  }

  const source = versionFileSource(version, sheetFilePath(sheet.name))
  if (!source) throw new Error(`[SixbApp] Sheet '${sheet.name}' has no file.`)
  const table: CsvTable = parseCsv(await fetchFileText(client, source))
  return sheetModel(sheet, table)
}
