import {
  ARTIFACT_LIMITS,
  parseCsv,
  parseWorkbook,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookSheet,
} from "@sixb/core/artifacts"
import { useMemo } from "react"
import type { FileSource } from "../../file-source"
import { type ArtifactVersion, useFileText, versionFileSource } from "../../queries"
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
