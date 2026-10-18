import {
  ARTIFACT_LIMITS,
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
import { type ArtifactVersion, fetchFileText, useFileText, versionFileSource } from "../../queries"
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
 */
export function useSheetModel(
  version: ArtifactVersion,
  sheet: WorkbookSheet | undefined
): {
  readonly model: SheetModel | null
  /** The sheet's CSV, which downloads as it is. */
  readonly source: FileSource | null
  readonly loading: boolean
  readonly tooLarge: boolean
} {
  const source = sheet ? versionFileSource(version, sheetFilePath(sheet.name)) : null
  const csv = useFileText(source, ARTIFACT_LIMITS.maxSheetFileBytes)
  const model = useMemo(() => {
    if (!sheet || csv.text === undefined) return null
    try {
      return sheetModel(sheet, parseCsv(csv.text))
    } catch {
      return null
    }
  }, [sheet, csv.text])
  return { model, source, loading: csv.loading, tooLarge: csv.tooLarge }
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
  return Promise.all(
    workbook.sheets.map(async (sheet) => {
      const source = versionFileSource(version, sheetFilePath(sheet.name))
      if (!source) throw new Error(`[SixbApp] Sheet '${sheet.name}' has no file.`)
      return sheetModel(sheet, parseCsv(await fetchFileText(client, source)))
    })
  )
}
