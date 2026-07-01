import { client } from "@sixb/client"
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Download, Eye, FileIcon, FileImage, FileText } from "lucide-react"
import {
  type FileRefValue,
  fileMediaLabel,
  fileRefName,
  formatFileSize,
  objectFileContentUrl,
} from "../../lib/files"

export interface FileRefAttachmentProps {
  readonly fileRef: FileRefValue
  readonly objectTypeId: string
  readonly primaryId: string
  readonly pathSegments: readonly string[]
}

export function FileRefAttachment({
  fileRef,
  objectTypeId,
  primaryId,
  pathSegments,
}: FileRefAttachmentProps) {
  const fileName = fileRefName(fileRef)
  const mediaLabel = fileMediaLabel(fileRef.mediaType, fileName)
  const baseUrl = client.getConfig().baseUrl ?? window.location.origin
  const context = { objectTypeId, primaryId, pathSegments }
  const inlineUrl = objectFileContentUrl({ baseUrl, context })
  const downloadUrl = objectFileContentUrl({ baseUrl, context, disposition: "attachment" })
  const { Icon, className } = fileIconPresentation(fileRef.mediaType, fileName)

  return (
    <Attachment size="sm" className="w-full max-w-[28rem] border-border/70 bg-background">
      <AttachmentTrigger asChild>
        <a href={inlineUrl} target="_blank" rel="noreferrer" aria-label={`View ${fileName}`} />
      </AttachmentTrigger>
      <AttachmentMedia className={cn("bg-muted/70", className)}>
        <Icon className="h-4 w-4" />
      </AttachmentMedia>
      <AttachmentContent className="min-w-0 pr-1">
        <AttachmentTitle title={fileName}>{fileName}</AttachmentTitle>
        <AttachmentDescription title={fileRef.digest}>
          {mediaLabel} · {formatFileSize(fileRef.sizeBytes)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions className="gap-1 pr-1">
        <AttachmentAction
          asChild
          variant="ghost"
          size="xs"
          className="h-6 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <a href={inlineUrl} target="_blank" rel="noreferrer">
            <Eye className="h-3.5 w-3.5" />
            View
          </a>
        </AttachmentAction>
        <AttachmentAction
          asChild
          variant="ghost"
          size="xs"
          className="h-6 px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <a href={downloadUrl} target="_blank" rel="noreferrer" download={fileName}>
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  )
}

function fileIconPresentation(mediaType: string | undefined, fileName: string) {
  const normalized = mediaType?.trim().toLowerCase()
  const lowerName = fileName.toLowerCase()

  if (normalized?.startsWith("image/")) {
    return { Icon: FileImage, className: "bg-sky-500/[0.08] text-sky-600 dark:text-sky-300" }
  }
  if (
    normalized === "application/pdf" ||
    normalized?.startsWith("text/") ||
    lowerName.endsWith(".pdf") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md")
  ) {
    return { Icon: FileText, className: "bg-rose-500/[0.08] text-rose-600 dark:text-rose-300" }
  }
  return { Icon: FileIcon, className: "bg-muted text-muted-foreground" }
}
