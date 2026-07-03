import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { File as FileIcon, FileImage, FileText, Table2 } from "lucide-react"
import type { AgentFileRef } from "../types"

export function FileAttachmentCard({
  fileRef,
  href,
  className,
}: {
  readonly fileRef: AgentFileRef
  readonly href?: string
  readonly className?: string
}) {
  const fileName = fileRef.fileName?.trim() || "File"
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)
  const { Icon, className: iconClassName } = fileIconPresentation(fileRef.mediaType, fileName)

  return (
    <Attachment
      size="sm"
      state="done"
      className={cn(
        "w-[20rem] max-w-[80vw] rounded-2xl border-border/70 bg-background shadow-sm",
        className
      )}
    >
      {href ? (
        <AttachmentTrigger asChild>
          <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${fileName}`} />
        </AttachmentTrigger>
      ) : null}
      <AttachmentMedia className={cn("size-9 rounded-xl bg-muted/80", iconClassName)}>
        <Icon className="size-4.5" />
      </AttachmentMedia>
      <AttachmentContent className="min-w-0 py-0 pr-2">
        <AttachmentTitle className="text-sm font-medium" title={fileName}>
          {fileName}
        </AttachmentTitle>
        <AttachmentDescription className="text-xs" title={fileRef.digest}>
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes)}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  )
}

function fileMediaLabel(mediaType: string | undefined, fileName: string): string {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()
  if (
    normalized?.includes("spreadsheet") ||
    normalized?.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(lowerName)
  ) {
    return "Spreadsheet"
  }
  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) return "PDF"
  if (normalized?.startsWith("image/")) return "Image"
  if (normalized === "text/markdown" || lowerName.endsWith(".md")) return "Markdown"
  if (normalized === "text/plain" || lowerName.endsWith(".txt")) return "Text"
  if (normalized?.startsWith("text/")) return "Document"
  if (normalized) return normalized
  return "File"
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "Unknown size"

  const units = ["B", "KB", "MB", "GB", "TB"] as const
  let value = sizeBytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const maximumFractionDigits = unitIndex === 0 || value >= 10 ? 0 : 1
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${units[unitIndex]}`
}

function fileIconPresentation(mediaType: string | undefined, fileName: string) {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()

  if (
    normalized?.includes("spreadsheet") ||
    normalized?.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(lowerName)
  ) {
    return { Icon: Table2, className: "bg-emerald-500 text-white" }
  }
  if (normalized?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lowerName)) {
    return { Icon: FileImage, className: "bg-sky-500/[0.08] text-sky-600 dark:text-sky-300" }
  }
  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) {
    return { Icon: FileText, className: "bg-rose-500/[0.08] text-rose-600 dark:text-rose-300" }
  }
  if (normalized?.startsWith("text/") || /\.(txt|md|json|yaml|yml)$/i.test(lowerName)) {
    return { Icon: FileText, className: "bg-muted text-muted-foreground" }
  }
  return { Icon: FileIcon, className: "bg-muted text-muted-foreground" }
}
