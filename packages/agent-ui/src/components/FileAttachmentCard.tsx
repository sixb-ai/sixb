import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { File as FileIcon, FileImage, FileText, Table2, X } from "lucide-react"
import { useDocumentPreview } from "../document-preview/DocumentPreviewRoot"
import { formatFileSize } from "../document-preview/file-size"
import type { AgentDocumentSource } from "../document-preview/types"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import type { AgentFileRef } from "../types"

export function FileAttachmentCard({
  fileRef,
  document,
  className,
}: {
  readonly fileRef: AgentFileRef
  readonly document?: AgentDocumentSource
  readonly className?: string
}) {
  const preview = useDocumentPreview()
  const messages = useAgentMessages().files
  const locale = useLocale()
  const fileName = fileRef.fileName?.trim() || messages.file
  const previewable = document !== undefined && preview?.canPreview(document) === true
  const selected = Boolean(document && previewable && preview?.activeDocumentId === document.id)
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName, messages)
  const { Icon, className: iconClassName } = fileIconPresentation(fileRef.mediaType, fileName)

  return (
    <Attachment
      size="sm"
      state="done"
      data-selected={selected ? "" : undefined}
      className={cn(
        "w-[20rem] max-w-[80vw] rounded-2xl border-border/70 bg-background shadow-sm",
        selected &&
          "border-foreground/25 bg-muted/70 shadow-none ring-1 ring-foreground/10 ring-inset",
        className
      )}
    >
      {document && previewable && preview ? (
        <AttachmentTrigger asChild>
          <button
            type="button"
            onClick={() =>
              selected ? preview.closeDocument(document.id) : preview.openDocument(document)
            }
            aria-label={selected ? messages.closePreview(fileName) : messages.preview(fileName)}
            aria-pressed={selected}
          />
        </AttachmentTrigger>
      ) : document ? (
        <AttachmentTrigger asChild>
          <a
            href={document.inlineUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={messages.open(fileName)}
          />
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
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes, locale, messages)}
        </AttachmentDescription>
      </AttachmentContent>
      {selected ? (
        <span
          aria-hidden="true"
          className="mr-2 flex size-6 shrink-0 items-center justify-center rounded-full bg-background/80 text-muted-foreground"
        >
          <X className="size-3.5" />
        </span>
      ) : null}
    </Attachment>
  )
}

function fileMediaLabel(
  mediaType: string | undefined,
  fileName: string,
  messages: AgentMessages["files"]
): string {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()
  if (
    normalized?.includes("spreadsheet") ||
    normalized?.includes("csv") ||
    /\.(csv|tsv|xls|xlsx)$/i.test(lowerName)
  ) {
    return messages.spreadsheet
  }
  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) return messages.pdf
  if (normalized?.startsWith("image/")) return messages.image
  if (normalized === "text/markdown" || lowerName.endsWith(".md")) return messages.markdown
  if (normalized === "text/plain" || lowerName.endsWith(".txt")) return messages.text
  if (normalized?.startsWith("text/")) return messages.document
  if (normalized) return normalized
  return messages.file
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
