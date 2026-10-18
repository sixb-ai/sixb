import { sheetFilePath } from "@sixb/core/artifacts"
import { useQueryClient } from "@tanstack/react-query"
import type { DownloadOption } from "../../downloads"
import { useArtifactMessages } from "../../messages"
import { type ArtifactVersion, versionFileSource } from "../../queries"
import { readWorkbookModels, useWorkbook } from "./workbook"
import { workbookXlsx, XLSX_MEDIA_TYPE } from "./xlsx"

/**
 * What a sheet artifact downloads as: the whole workbook as an `.xlsx`, built in the browser from
 * the sheets' files, typed and formatted as the grid shows them; then each sheet as its CSV.
 */
export function useWorkbookDownloads(
  version: ArtifactVersion,
  title: string
): readonly DownloadOption[] {
  const messages = useArtifactMessages().sheet
  const client = useQueryClient()
  const { workbook } = useWorkbook(version)
  if (!workbook) return []
  const outline = version.outline.kind === "sheet" ? version.outline.sheets : []
  return [
    {
      key: "xlsx",
      type: "xlsx",
      title: messages.excelWorkbook,
      detail: messages.workbookDetail(workbook.sheets.length),
      run: async () => {
        const bytes = await workbookXlsx(await readWorkbookModels(client, version, workbook))
        saveFile(
          new Blob([bytes as BlobPart], { type: XLSX_MEDIA_TYPE }),
          `${fileStem(title)}.xlsx`
        )
      },
    },
    ...workbook.sheets.flatMap((sheet): DownloadOption[] => {
      const source = versionFileSource(version, sheetFilePath(sheet.name))
      return source
        ? [
            {
              key: `csv:${sheet.name}`,
              type: "csv",
              title: sheet.name,
              detail: messages.csvDetail(outline.find((entry) => entry.name === sheet.name)?.rows),
              section: messages.sheetsAsCsv,
              href: source.downloadUrl,
              fileName: `${sheet.name}.csv`,
            },
          ]
        : []
    }),
  ]
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  // The click starts the download before the next task; the URL is no longer needed after.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** A title as a file name: what the file system can take, and not empty. */
function fileStem(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .trim()
      .slice(0, 120) || "workbook"
  )
}
