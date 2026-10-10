import { cn } from "@sixb/ui/lib/utils"
import { Eye, File as FileIcon } from "lucide-react"
import type { ReactNode } from "react"
import { ActivityStatusText } from "../components/ActivityStatus"
import { useDocumentPreview } from "../document-preview/DocumentPreviewRoot"
import { formatFileSize } from "../document-preview/file-size"
import type { NormalizedFile, NormalizedTool } from "../parts"
import { describeViewFile } from "./interpret"

/**
 * A file the agent viewed. It belongs to the work, not to the answer, so it stays in the trace: an
 * image as a small preview, any other file as a compact chip, each opening the document preview.
 */
export function ViewFileToolView({ tool }: { tool: NormalizedTool }) {
  const { target, file } = describeViewFile(tool)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const label =
    tool.state === "output-error"
      ? `Couldn't view ${target}`
      : `${running ? "Viewing" : "Viewed"} ${target}`

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <Eye className="size-3.5 shrink-0" />
        {running ? (
          <ActivityStatusText label={label} className="font-medium shimmer" />
        ) : (
          <span className="min-w-0 truncate font-medium">{label}</span>
        )}
      </div>
      {file && tool.state === "output-available" ? (
        <div className="pl-5">
          <ViewedFile file={file} />
        </div>
      ) : null}
    </div>
  )
}

function ViewedFile({ file }: { file: NormalizedFile }) {
  const { fileRef, document } = file
  const name = fileRef.fileName?.trim() || "File"

  if (document?.kind === "image") {
    return (
      <OpenFile file={file} name={name}>
        <img
          src={document.inlineUrl}
          alt={name}
          loading="lazy"
          className="block h-auto max-h-28 w-auto max-w-[min(10rem,100%)] rounded-md border border-border/70 bg-muted/40 object-contain"
        />
      </OpenFile>
    )
  }

  return (
    <OpenFile file={file} name={name}>
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground">
        <FileIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-foreground/80">{name}</span>
        <span className="shrink-0 text-muted-foreground/60">
          {formatFileSize(fileRef.sizeBytes)}
        </span>
      </span>
    </OpenFile>
  )
}

/** Open a saved file in the document preview, or in a new tab when no viewer handles it. */
function OpenFile({
  file,
  name,
  children,
}: {
  file: NormalizedFile
  name: string
  children: ReactNode
}) {
  const preview = useDocumentPreview()
  const { document } = file
  const className = cn(
    "block w-fit max-w-full rounded-md outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
    document && "hover:opacity-80"
  )

  if (document && preview?.canPreview(document)) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => preview.openDocument(document)}
        aria-label={`Preview ${name}`}
      >
        {children}
      </button>
    )
  }
  if (document) {
    return (
      <a
        href={document.inlineUrl}
        target="_blank"
        rel="noreferrer"
        className={className}
        aria-label={`Open ${name}`}
      >
        {children}
      </a>
    )
  }
  return <span className={className}>{children}</span>
}
