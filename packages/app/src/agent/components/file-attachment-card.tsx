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
import { formatFileSize } from "../../artifacts/file-size"
import type { FileSource } from "../../artifacts/file-source"
import { viewerTargetKey } from "../../artifacts/target"
import { useArtifactPanel } from "../artifact-panel"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import type { AgentFileRef } from "../types"

export function FileAttachmentCard({
  fileRef,
  source,
  className,
}: {
  readonly fileRef: AgentFileRef
  readonly source?: FileSource
  readonly className?: string
}) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages().files
  const locale = useLocale()
  const fileName = fileRef.fileName?.trim() || messages.file
  const target = source ? ({ type: "file", source } as const) : null
  const selected = Boolean(target && panel?.openKey === viewerTargetKey(target))
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName, messages)
  const { Icon, className: iconClassName } = fileIconPresentation(fileRef.mediaType, fileName)

  return (
    <Attachment
      size="sm"
      state="done"
      data-selected={selected ? "" : undefined}
      className={cn(
        "w-[20rem] max-w-[80vw] rounded-2xl border-transparent bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-black/[0.06] dark:shadow-none dark:ring-white/10",
        selected &&
          "border-foreground/25 bg-muted/70 shadow-none ring-1 ring-foreground/10 ring-inset",
        className
      )}
    >
      {target && panel ? (
        <AttachmentTrigger asChild>
          <button
            type="button"
            onClick={() => (selected ? panel.close() : panel.open(target))}
            aria-label={selected ? messages.closePreview(fileName) : messages.preview(fileName)}
            aria-pressed={selected}
          />
        </AttachmentTrigger>
      ) : source ? (
        <AttachmentTrigger asChild>
          <a
            href={source.inlineUrl}
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
    return {
      Icon: Table2,
      className: "bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-300",
    }
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
