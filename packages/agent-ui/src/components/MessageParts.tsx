import { Collapsible, CollapsibleContent, CollapsibleTrigger, Markdown } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight, Wrench } from "lucide-react"
import { memo, useState } from "react"
import { latestWorkLabel } from "../activity-label"
import { BashToolView } from "../bash/BashToolView"
import type { NormalizedPart, NormalizedTool } from "../parts"
import { ReadToolView } from "../read/ReadToolView"
import { FileAttachmentCard } from "./FileAttachmentCard"

/**
 * Render an assistant body from normalized parts. Narration text stays on the main reading path;
 * every run of consecutive reasoning + tool parts collapses into a single "work" disclosure, so a
 * long chain of thinking and tool calls reads as one quiet line above the answer instead of a stack
 * of separate dropdowns. `step-start` markers are intentionally skipped.
 */
export function AssistantBody({
  parts,
  live = false,
}: {
  parts: readonly NormalizedPart[]
  /** True while this body is driven by an in-flight run, so its headline shows live progress. */
  live?: boolean
}) {
  const blocks: React.ReactNode[] = []
  let textBuffer: string[] = []
  let workBuffer: NormalizedPart[] = []
  let key = 0

  const flushText = () => {
    if (textBuffer.length === 0) return
    const text = textBuffer.join("")
    textBuffer = []
    if (!text.trim()) return
    blocks.push(<TextBlock key={`block-${key++}`} text={text} />)
  }

  const flushWork = (inProgress: boolean) => {
    if (workBuffer.length === 0) return
    const work = workBuffer
    workBuffer = []
    // A run of only step boundaries has nothing to show.
    if (work.every((part) => part.kind === "step-start")) return
    blocks.push(<WorkGroup key={`block-${key++}`} parts={work} inProgress={inProgress} />)
  }

  parts.forEach((part) => {
    if (part.kind === "text") {
      textBuffer.push(part.text)
      // Only real narration ends a work run. Whitespace-only text parts (the model emits one per
      // step boundary) must not fragment a chain into a stack of separate "Worked" groups. A group
      // flushed here has narration after it, so it is settled — never the in-progress trailing run.
      if (part.text.trim()) flushWork(false)
      return
    }
    if (part.kind === "file") {
      flushText()
      flushWork(false)
      blocks.push(<FileBlock key={`block-${key++}`} part={part} />)
      return
    }
    // reasoning | tool | step-start — buffered together into one work run.
    flushText()
    workBuffer.push(part)
  })
  flushText()
  // The final work run is the only one that can still be receiving steps.
  flushWork(live)

  return <div className="flex flex-col gap-3">{blocks}</div>
}

const TextBlock = memo(function TextBlock({ text }: { text: string }) {
  return <Markdown className="prose-chat">{text}</Markdown>
})

const FileBlock = memo(function FileBlock({
  part,
}: {
  part: Extract<NormalizedPart, { kind: "file" }>
}) {
  return <FileAttachmentCard fileRef={part.fileRef} document={part.document} />
})

/**
 * A consecutive run of reasoning + tool parts, folded into a single disclosure. It stays closed
 * unless the user explicitly opens it, including while work is live. The collapsed shimmer follows
 * the newest step, keeping the main transcript informative without exposing debug detail. Inside,
 * items flow in one indented column and can expand inline when deeper inspection is useful.
 */
function WorkGroup({
  parts,
  inProgress,
}: {
  parts: readonly NormalizedPart[]
  inProgress: boolean
}) {
  const [open, setOpen] = useState(false)

  const toolCount = parts.reduce((count, part) => count + (part.kind === "tool" ? 1 : 0), 0)
  const hasTools = toolCount > 0
  const label = inProgress ? `${latestWorkLabel(parts)}…` : hasTools ? "Worked" : "Reasoning"
  const detail =
    !inProgress && hasTools ? `${toolCount} ${toolCount === 1 ? "step" : "steps"}` : undefined

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-full">
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] leading-normal text-muted-foreground outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span className={cn(inProgress && "shimmer")}>{label}</span>
        {detail ? <span className="text-muted-foreground/60">· {detail}</span> : null}
        <ChevronRight className="size-4 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="scrollbar-thin mt-2 ml-1.5 flex max-h-[min(24rem,50vh)] flex-col gap-3 overflow-y-auto overscroll-contain border-l-2 border-border py-0.5 pr-2 pl-3">
          {parts.map((part, index) => {
            if (part.kind === "reasoning") {
              return <GroupReasoning key={index} text={part.text} streaming={part.streaming} />
            }
            if (part.kind === "tool") {
              return <ToolCallRow key={index} tool={part.tool} />
            }
            return null
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Reasoning inside a work group: plain, quiet text that flows with the rest of the chain. */
function GroupReasoning({ text, streaming }: { text: string; streaming: boolean }) {
  if (!text.trim()) return null
  return (
    <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/80">
      {text}
      {streaming ? <span className="shimmer">▍</span> : null}
    </p>
  )
}

/**
 * A single tool call within a work group. Framework tools render through purpose-built views;
 * project tools fall back to the generic inspector. Both keep their bodies
 * borderless and inline so an expanded result flows within the group rather than reading as a
 * nested dropdown.
 */
function ToolCallRow({ tool }: { tool: NormalizedTool }) {
  if (tool.toolName === "bash") {
    return (
      <BashToolView
        tool={{
          state: tool.state,
          input: tool.input,
          inputText: tool.inputText,
          output: tool.output,
          errorText: tool.errorText,
        }}
      />
    )
  }
  if (tool.toolName === "read") return <ReadToolView tool={tool} />

  const isError = tool.state === "output-error"
  const hasInput = tool.input !== undefined || Boolean(tool.inputText)
  const hasOutput = tool.state === "output-available" && tool.output !== undefined
  const hasErrorDetail = isError && Boolean(tool.errorText)
  const expandable = hasInput || hasOutput || hasErrorDetail

  // Errors read as the same quiet marker as any other tool — no red in the transcript. The failure
  // detail lives inside the disclosure for anyone who wants to expand and debug it.
  return (
    <div className="min-w-0">
      <Collapsible>
        <CollapsibleTrigger
          disabled={!expandable}
          className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          <Wrench className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium">{tool.toolName}</span>
          <ToolStatus state={tool.state} />
          {expandable ? (
            <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          {hasInput ? <JsonViewer label="Input" value={tool.input ?? tool.inputText} /> : null}
          {hasOutput ? <JsonViewer label="Output" value={tool.output} /> : null}
          {hasErrorDetail ? <JsonViewer label="Details" value={tool.errorText} /> : null}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ToolStatus({ state }: { state: NormalizedTool["state"] }) {
  // Only the in-flight state is worth a badge; a finished call (done or errored) reads from the
  // marker itself, keeping failures from flashing red in the transcript.
  const running = state === "input-streaming" || state === "input-available"
  if (!running) return null
  return (
    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 shimmer">
      running
    </span>
  )
}

function JsonViewer({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
        {formatValue(value)}
      </pre>
    </div>
  )
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
