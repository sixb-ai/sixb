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
 * image as an inline thumbnail beside its label, any other file as a compact chip, each opening in
 * the artifact panel.
 */
export function ViewFileToolView({ tool }: { tool: NormalizedTool }) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.viewFile
  const { target, file } = describeViewFile(tool)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const label =
    tool.state === "output-error"
      ? messages.failed(target)
      : running
        ? messages.running(target)
        : messages.title(target)

  if (
    file &&
    tool.state === "output-available" &&
    file.source &&
    fileView(file.fileRef) === "image"
  ) {
    const name = file.fileRef.fileName?.trim() || agentMessages.files.file
    return (
      <div className="min-w-0">
        <OpenFile file={file} name={name}>
          <span className="group/view flex w-fit max-w-full items-center gap-2 rounded-md py-0.5 pr-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
            <img
              src={file.source.inlineUrl}
              alt={name}
              loading="lazy"
              className="size-9 shrink-0 rounded-md border border-border/80 bg-muted/40 object-cover transition-transform group-hover/view:scale-[1.03]"
            />
            <Eye className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{label}</span>
          </span>
        </OpenFile>
      </div>
    )
  }

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
          <ViewedFileChip file={file} />
        </div>
      ) : null}
    </div>
  )
}

function ViewedFileChip({ file }: { file: NormalizedFile }) {
  const messages = useAgentMessages().files
  const locale = useLocale()
  const { fileRef } = file
  const name = fileRef.fileName?.trim() || messages.file

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
    source && "hover:opacity-85"
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
