import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { BookOpen, ChevronRight, FileText, type LucideIcon } from "lucide-react"
import { ActivityStatusText } from "../components/ActivityStatus"
import type { NormalizedTool } from "../parts"
import { coerceReadInput, coerceReadOutput, describeRead } from "./interpret"

export function ReadToolView({ tool }: { tool: NormalizedTool }) {
  const input = coerceReadInput(tool.input)
  const output = coerceReadOutput(tool.output)
  const description = describeRead(input, output)
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const error = tool.state === "output-error"
  const Icon = description.skill ? BookOpen : FileText
  const label = error
    ? `Couldn't read ${description.target}`
    : `${running ? "Reading" : "Read"} ${description.target}`

  if (running || (description.skill && !error)) {
    return <ReadLine icon={Icon} label={label} detail={description.detail} running={running} />
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">{label}</span>
        {description.detail ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/60">
            {description.detail}
          </span>
        ) : null}
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
            <ReadBlock value={tool.errorText?.trim() || "The file could not be read."} />
          ) : output?.content ? (
            <ReadBlock value={output.content} />
          ) : output ? (
            <p className="text-muted-foreground/60">This file is empty.</p>
          ) : (
            <p className="text-muted-foreground/60">No file content was returned.</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ReadLine({
  icon: Icon,
  label,
  detail,
  running,
}: {
  icon: LucideIcon
  label: string
  detail?: string
  running: boolean
}) {
  return (
    <div className="flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      {running ? (
        <ActivityStatusText label={label} className="font-medium shimmer" />
      ) : (
        <span className="min-w-0 truncate font-medium">{label}</span>
      )}
      {detail ? (
        <span className="min-w-0 shrink truncate text-muted-foreground/60">{detail}</span>
      ) : null}
    </div>
  )
}

function ReadBlock({ value }: { value: string }) {
  return (
    <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
      {value}
    </pre>
  )
}
