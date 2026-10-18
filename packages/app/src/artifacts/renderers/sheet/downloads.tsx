import type { Workbook } from "@sixb/core/artifacts"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { useQueryClient } from "@tanstack/react-query"
import { Download, FileSpreadsheet, FileText, LoaderCircle } from "lucide-react"
import { useState } from "react"
import type { FileSource } from "../../file-source"
import { useArtifactMessages } from "../../messages"
import type { ArtifactVersion } from "../../queries"
import { readWorkbookModels } from "./workbook"
import { workbookXlsx, XLSX_MEDIA_TYPE } from "./xlsx"

/**
 * A sheet's downloads: the open sheet as its CSV, or the whole workbook as an `.xlsx` built in the
 * browser from the sheets' files, typed and formatted as the grid shows them.
 */
export function SheetDownloads({
  version,
  workbook,
  sheet,
  source,
  title,
}: {
  readonly version: ArtifactVersion
  readonly workbook: Workbook
  /** The open sheet's name, and its CSV. */
  readonly sheet: string
  readonly source: FileSource | null
  /** The artifact's title, which names the `.xlsx`. */
  readonly title: string
}) {
  const messages = useArtifactMessages().sheet
  const client = useQueryClient()
  const [state, setState] = useState<"idle" | "working" | "failed">("idle")

  const downloadXlsx = async () => {
    setState("working")
    try {
      const bytes = await workbookXlsx(await readWorkbookModels(client, version, workbook))
      saveFile(new Blob([bytes as BlobPart], { type: XLSX_MEDIA_TYPE }), `${fileStem(title)}.xlsx`)
      setState("idle")
    } catch (error) {
      console.warn("[SixbApp] Could not build the workbook's .xlsx:", error)
      setState("failed")
    }
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {state === "failed" ? (
        <span role="status" className="text-xs text-destructive">
          {messages.xlsxFailed}
        </span>
      ) : null}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={messages.download}
          title={messages.download}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          {state === "working" ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-3.5" aria-hidden="true" />
          )}
          <span className="hidden @lg:inline">{messages.download}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {source ? (
            <DropdownMenuItem asChild>
              <a href={source.downloadUrl} download={`${sheet}.csv`}>
                <FileText aria-hidden="true" />
                {messages.sheetAsCsv(sheet)}
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={state === "working"} onSelect={() => void downloadXlsx()}>
            <FileSpreadsheet aria-hidden="true" />
            {messages.downloadXlsx}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
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
