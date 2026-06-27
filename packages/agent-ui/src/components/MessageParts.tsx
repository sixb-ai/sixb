import { Collapsible, CollapsibleContent, CollapsibleTrigger, Markdown } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { AlertTriangle, ChevronRight, Wrench } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { LivePart } from "../liveRun"
import type { AgentMessagePart } from "../types"

// A render-ready view of a message part, shared by durable messages and the live streaming row.
export type NormalizedTool = {
  readonly toolName: string
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error"
  readonly input?: unknown
  readonly inputText?: string
  readonly output?: unknown
  readonly errorText?: string
}

export type NormalizedPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly streaming: boolean }
  | { readonly kind: "tool"; readonly tool: NormalizedTool }
  | { readonly kind: "step-start" }

export function normalizeDurableParts(parts: readonly AgentMessagePart[]): NormalizedPart[] {
  return parts.map((part): NormalizedPart => {
    switch (part.type) {
      case "text":
        return { kind: "text", text: part.text }
      case "reasoning":
        return { kind: "reasoning", text: part.text, streaming: false }
      case "tool-call":
        return {
          kind: "tool",
          tool:
            part.state === "output-available"
              ? {
                  toolName: part.toolName,
                  state: part.state,
                  input: part.input,
                  output: part.output,
                }
              : {
                  toolName: part.toolName,
                  state: part.state,
                  input: part.input,
                  errorText: part.errorText,
                },
        }
      default:
        return { kind: "step-start" }
    }
  })
}

export function normalizeLiveParts(parts: readonly LivePart[]): NormalizedPart[] {
  return parts.map((part): NormalizedPart => {
    switch (part.kind) {
      case "text":
        return { kind: "text", text: part.text }
      case "reasoning":
        return { kind: "reasoning", text: part.text, streaming: !part.done }
      default:
        return {
          kind: "tool",
          tool: {
            toolName: part.toolName,
            state: part.state,
            input: part.input,
            inputText: part.inputText,
            output: part.output,
            errorText: part.errorText,
          },
        }
    }
  })
}

/**
 * Render an assistant body from normalized parts. Adjacent text parts are merged into a single
 * readable block; reasoning collapses away from the main reading path; tool calls render as
 * structured rows. `step-start` markers are intentionally skipped.
 */
export function AssistantBody({ parts }: { parts: readonly NormalizedPart[] }) {
  const blocks: React.ReactNode[] = []
  let textBuffer: string[] = []

  const flushText = (key: string) => {
    if (textBuffer.length === 0) return
    const text = textBuffer.join("")
    textBuffer = []
    if (!text.trim()) return
    blocks.push(<TextBlock key={key} text={text} />)
  }

  parts.forEach((part, index) => {
    if (part.kind === "text") {
      textBuffer.push(part.text)
      return
    }
    flushText(`text-${index}`)
    if (part.kind === "reasoning") {
      blocks.push(
        <ReasoningBlock key={`reasoning-${index}`} text={part.text} streaming={part.streaming} />
      )
    } else if (part.kind === "tool") {
      blocks.push(<ToolCallRow key={`tool-${index}`} tool={part.tool} />)
    }
  })
  flushText("text-final")

  return <div className="flex flex-col gap-3">{blocks}</div>
}

function TextBlock({ text }: { text: string }) {
  return <Markdown>{text}</Markdown>
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming)
  const wasStreamingRef = useRef(streaming)

  useEffect(() => {
    if (streaming && !wasStreamingRef.current) {
      setOpen(true)
    } else if (!streaming && wasStreamingRef.current) {
      setOpen(false)
    }

    wasStreamingRef.current = streaming
  }, [streaming])

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-fit max-w-full">
      <CollapsibleTrigger className="group mb-1 flex items-center gap-1.5 text-[13px] leading-none text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(streaming && "shimmer")}>{streaming ? "Reasoning…" : "Reasoning"}</span>
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ReasoningPreview text={text} streaming={streaming} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ReasoningPreview({ text, streaming }: { text: string; streaming: boolean }) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const [showTopFade, setShowTopFade] = useState(false)
  const textLength = text.length

  useEffect(() => {
    if (textLength === 0) {
      setShowTopFade(false)
      return
    }

    const viewport = viewportRef.current
    if (!viewport || !streaming || !stickToBottomRef.current) {
      return
    }

    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
      setShowTopFade(viewport.scrollTop > 4)
    })

    return () => cancelAnimationFrame(frame)
  }, [streaming, textLength])

  return (
    <div className="relative mt-1.5 ml-1.5 max-w-full border-l-2 border-border pl-3">
      {showTopFade ? (
        <div className="pointer-events-none absolute top-0 right-0 left-3 z-10 h-7 bg-gradient-to-b from-background via-background/85 to-transparent" />
      ) : null}
      <div
        ref={viewportRef}
        className="scrollbar-thin max-h-52 overflow-y-auto pr-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground overscroll-contain sm:max-h-64"
        onScroll={(event) => {
          const viewport = event.currentTarget
          const distanceFromBottom =
            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
          stickToBottomRef.current = distanceFromBottom < 24
          setShowTopFade(viewport.scrollTop > 4)
        }}
      >
        {text}
      </div>
    </div>
  )
}

function ToolCallRow({ tool }: { tool: NormalizedTool }) {
  const isError = tool.state === "output-error"
  const hasInput = tool.input !== undefined || Boolean(tool.inputText)
  const hasOutput = tool.state === "output-available" && tool.output !== undefined

  return (
    <div
      className={cn(
        "w-full max-w-full overflow-hidden rounded-md border text-xs",
        isError ? "border-destructive/30 bg-destructive/5" : "border-border bg-muted/30"
      )}
    >
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          {isError ? (
            <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
          ) : (
            <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate font-medium text-foreground">{tool.toolName}</span>
          <ToolStatus state={tool.state} />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 px-2.5 pb-2.5">
          {hasInput ? <JsonViewer label="Input" value={tool.input ?? tool.inputText} /> : null}
          {hasOutput ? <JsonViewer label="Output" value={tool.output} /> : null}
        </CollapsibleContent>
      </Collapsible>
      {isError && tool.errorText ? (
        <p className="whitespace-pre-wrap border-t border-destructive/20 px-2.5 py-1.5 text-destructive">
          {tool.errorText}
        </p>
      ) : null}
    </div>
  )
}

function ToolStatus({ state }: { state: NormalizedTool["state"] }) {
  const running = state === "input-streaming" || state === "input-available"
  const label =
    state === "output-error" ? "error" : state === "output-available" ? "done" : "running"
  return (
    <span
      className={cn(
        "ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wide",
        state === "output-error" ? "text-destructive" : "text-muted-foreground",
        running && "shimmer"
      )}
    >
      {label}
    </span>
  )
}

function JsonViewer({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-relaxed text-foreground">
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
