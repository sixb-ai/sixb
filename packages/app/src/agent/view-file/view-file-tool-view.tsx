import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { Eye, File as FileIcon } from "lucide-react"
import type { ReactNode } from "react"
import { formatFileSize } from "../../artifacts/file-size"
import { fileView } from "../../artifacts/file-view"
import { useArtifactPanel } from "../artifact-panel"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedFile, NormalizedTool } from "../parts"
import { describeViewFile } from "./interpret"

/**
 * A file the agent viewed. It belongs to the work, not to the answer, so it stays in the trace: an
 * image as a small preview, any other file as a compact chip, each opening in the artifact panel.
 */
export function ViewFileToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages().viewFile
  const { target, file } = describeViewFile(tool)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const label =
    tool.state === "output-error"
      ? messages.failed(target)
      : running
        ? messages.running(target)
        : messages.title(target)

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
  const messages = useAgentMessages().files
  const locale = useLocale()
  const { fileRef, source } = file
  const name = fileRef.fileName?.trim() || messages.file

  if (source && fileView(fileRef) === "image") {
    return (
      <OpenFile file={file} name={name}>
        <img
          src={source.inlineUrl}
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
          {formatFileSize(fileRef.sizeBytes, locale, messages)}
        </span>
      </span>
    </OpenFile>
  )
}

/** Open a saved file in the artifact panel, or in a new tab outside a conversation. */
function OpenFile({
  file,
  name,
  children,
}: {
  file: NormalizedFile
  name: string
  children: ReactNode
}) {
  const panel = useArtifactPanel()
  const messages = useAgentMessages()
  const { source } = file
  const className = cn(
    "block w-fit max-w-full rounded-md outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring",
    source && "hover:opacity-80"
  )

  if (source && panel) {
    return (
      <button
        type="button"
        className={className}
        onClick={() => panel.open({ type: "file", source })}
        aria-label={messages.files.preview(name)}
      >
        {children}
      </button>
    )
  }
  if (source) {
    return (
      <a
        href={source.inlineUrl}
        target="_blank"
        rel="noreferrer"
        className={className}
        aria-label={messages.viewFile.open(name)}
      >
        {children}
      </a>
    )
  }
  return <span className={className}>{children}</span>
}
