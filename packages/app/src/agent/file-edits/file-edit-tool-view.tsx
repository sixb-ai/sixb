import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, FilePen, FilePlus } from "lucide-react"
import { ActivityStatusText } from "../components/activity-status"
import { useAgentMessages } from "../i18n"
import type { NormalizedTool } from "../parts"
import { type DiffLine, describeEdit, describeWrite, type FileEditDescription } from "./interpret"

/** A change the agent made to part of a file: its name and `+3 −1`, opening to the diff. */
export function EditToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages()
  return (
    <FileEditRow tool={tool} description={describeEdit(tool, messages)} icon={FilePen} counts />
  )
}

/** A file the agent created or replaced whole: its name and lines, opening to what it wrote. */
export function WriteToolView({ tool }: { tool: NormalizedTool }) {
  const messages = useAgentMessages()
  return <FileEditRow tool={tool} description={describeWrite(tool, messages)} icon={FilePlus} />
}

function FileEditRow({
  tool,
  description,
  icon: Icon,
  counts = false,
}: {
  tool: NormalizedTool
  description: FileEditDescription
  icon: typeof FilePen
  /** Show the lines added and removed, in the diff's colors, rather than the detail text. */
  counts?: boolean
}) {
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const error = tool.state === "output-error"
  const label = error
    ? description.failedTitle
    : running
      ? description.runningTitle
      : description.title

  if (running) {
    return (
      <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <ActivityStatusText label={label} className="font-medium shimmer" />
      </div>
    )
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{label}</span>
        {error || !description.detail ? null : counts ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{description.added}</span>{" "}
            <span className="text-red-600 dark:text-red-400">−{description.removed}</span>
          </span>
        ) : (
          <span className="min-w-0 shrink truncate text-muted-foreground/60">
            {description.detail}
          </span>
        )}
        <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 min-w-0 space-y-2 text-xs">
          {description.path ? (
            <p className="truncate font-mono text-[10px] text-muted-foreground/60">
              {description.path}
            </p>
          ) : null}
          {error ? (
            <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
              {tool.errorText?.trim()}
            </pre>
          ) : (
            <DiffBlock lines={description.lines} />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const LINE_CLASS: Record<DiffLine["kind"], string> = {
  hunk: "text-muted-foreground/60",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  removed: "bg-red-500/10 text-red-700 dark:text-red-300",
  context: "text-foreground/80",
  note: "text-muted-foreground/60 italic",
}

const LINE_MARK: Record<DiffLine["kind"], string> = {
  hunk: "",
  added: "+",
  removed: "−",
  context: " ",
  note: "",
}

function DiffBlock({ lines }: { lines: readonly DiffLine[] }) {
  return (
    <pre className="scrollbar-thin max-h-72 overflow-auto rounded bg-muted/50 py-1.5 text-[11px] leading-relaxed">
      {lines.map((line, index) => (
        <div
          // Lines of one diff never reorder: the index is their identity.
          key={index}
          className={cn("flex min-w-max gap-2 px-2", LINE_CLASS[line.kind])}
        >
          {line.kind === "hunk" || line.kind === "note" ? (
            <span>{line.text}</span>
          ) : (
            <>
              <span className="w-2 shrink-0 select-none opacity-70">{LINE_MARK[line.kind]}</span>
              <span>{line.text || " "}</span>
            </>
          )}
        </div>
      ))}
    </pre>
  )
}
