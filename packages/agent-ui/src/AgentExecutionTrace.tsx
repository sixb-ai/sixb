import { Collapsible, CollapsibleContent, CollapsibleTrigger, Markdown } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  MessageSquareText,
  Wrench,
  XCircle,
} from "lucide-react"
import { type ReactElement, useEffect, useState } from "react"
import { FileAttachmentCard } from "./components/FileAttachmentCard"
import { AssistantBody } from "./components/MessageParts"
import { type NormalizedPart, normalizeDurableParts } from "./parts"
import type { AgentMessagePart } from "./types"

export type AgentExecutionTraceVariant = "conversation" | "debug"

export interface AgentExecutionTraceProps {
  readonly parts: readonly AgentMessagePart[]
  readonly variant?: AgentExecutionTraceVariant
}

/** Read-only durable agent work, without thread or composer chrome. */
export function AgentExecutionTrace({ parts, variant = "conversation" }: AgentExecutionTraceProps) {
  const normalized = normalizeDurableParts(parts)
  return variant === "debug" ? (
    <DebugTrace parts={normalized} />
  ) : (
    <AssistantBody parts={normalized} />
  )
}

interface DebugStep {
  readonly parts: readonly NormalizedPart[]
}

function DebugTrace({ parts }: { parts: readonly NormalizedPart[] }) {
  const steps = splitIntoSteps(parts)
  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <DebugStepCard
          key={index}
          step={step}
          index={index}
          finalStep={index === steps.length - 1}
        />
      ))}
    </div>
  )
}

function splitIntoSteps(parts: readonly NormalizedPart[]): readonly DebugStep[] {
  const steps: DebugStep[] = []
  let current: NormalizedPart[] = []

  const flush = () => {
    if (current.length === 0) return
    steps.push({ parts: current })
    current = []
  }

  for (const part of parts) {
    if (part.kind === "step-start") {
      flush()
    } else {
      current.push(part)
    }
  }
  flush()
  return steps
}

function DebugStepCard({
  step,
  index,
  finalStep,
}: {
  step: DebugStep
  index: number
  finalStep: boolean
}) {
  const reasoning = step.parts
    .filter(
      (part): part is Extract<NormalizedPart, { kind: "reasoning" }> => part.kind === "reasoning"
    )
    .map((part) => part.text)
    .filter(Boolean)
    .join("\n\n")
  const tools = step.parts.filter(
    (part): part is Extract<NormalizedPart, { kind: "tool" }> => part.kind === "tool"
  )
  const files = step.parts.filter(
    (part): part is Extract<NormalizedPart, { kind: "file" }> => part.kind === "file"
  )
  const text = step.parts
    .filter((part): part is Extract<NormalizedPart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("")
    .trim()
  const failedTools = tools.filter((part) => part.tool.state === "output-error").length
  const finalAnswer = finalStep && tools.length === 0 && text.length > 0
  const detail = finalAnswer
    ? "Final response"
    : tools.length > 0
      ? `${tools.length} ${tools.length === 1 ? "tool call" : "tool calls"}`
      : "Model response"

  return (
    <section className="overflow-hidden rounded-lg border border-border/70 bg-background/40">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Step {index + 1}
          </span>
          <span className="truncate text-xs text-muted-foreground/70">{detail}</span>
        </div>
        {failedTools > 0 ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-destructive">
            <XCircle className="size-3.5" /> Failed
          </span>
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
      </div>
      <div className="space-y-3 px-3 py-3">
        {reasoning ? <ReasoningDisclosure text={reasoning} /> : null}
        {text ? (
          finalAnswer ? (
            <FinalAnswerDisclosure text={text} />
          ) : (
            <div className="space-y-1.5">
              <DebugLabel icon={<MessageSquareText />} label="Agent message" />
              <Markdown className="prose-chat text-sm">{text}</Markdown>
            </div>
          )
        ) : null}
        {tools.map((part, toolIndex) => (
          <DebugToolCall key={`${part.tool.toolName}-${toolIndex}`} tool={part.tool} />
        ))}
        {files.map((part, fileIndex) => (
          <div key={`${part.fileRef.blobId}-${fileIndex}`} className="space-y-1.5">
            <DebugLabel icon={<FileText />} label="File" />
            <FileAttachmentCard fileRef={part.fileRef} document={part.document} />
          </div>
        ))}
      </div>
    </section>
  )
}

function ReasoningDisclosure({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <Brain className="size-3.5" />
        Reasoning
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="mt-2 border-l-2 border-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function FinalAnswerDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Final answer</span>
        <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      {open ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </p>
      )}
      <CollapsibleContent>
        <Markdown className="prose-chat mt-2 text-sm">{text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  )
}

function DebugToolCall({ tool }: { tool: Extract<NormalizedPart, { kind: "tool" }>["tool"] }) {
  const failed = tool.state === "output-error"
  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const status = failed ? "Failed" : running ? "Running" : "Succeeded"
  return (
    <Collapsible defaultOpen={failed}>
      <div
        className={cn("overflow-hidden rounded-md", failed ? "bg-destructive/5" : "bg-muted/30")}
      >
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/30">
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
            {tool.toolName}
          </span>
          <span
            className={cn(
              "shrink-0 text-[10px] font-medium",
              failed
                ? "text-destructive"
                : running
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {status}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/60 px-3 py-3">
            {tool.input !== undefined || tool.inputText ? (
              <DebugValue label="Input" value={tool.input ?? tool.inputText} />
            ) : null}
            {tool.state === "output-available" && tool.output !== undefined ? (
              <DebugValue label="Output" value={tool.output} />
            ) : null}
            {failed ? (
              <DebugValue label="Error" value={tool.errorText ?? "The tool call failed."} error />
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function DebugValue({
  label,
  value,
  error = false,
}: {
  label: string
  value: unknown
  error?: boolean
}) {
  const formatted = formatValue(value)
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <CopyValueButton value={formatted} label={`Copy tool ${label.toLowerCase()}`} />
      </div>
      <pre
        className={cn(
          "scrollbar-thin max-h-72 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed text-foreground",
          error ? "bg-destructive/10" : "bg-background/60"
        )}
      >
        {formatted}
      </pre>
    </div>
  )
}

function DebugLabel({ icon, label }: { icon: ReactElement; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span className="[&_svg]:size-3.5">{icon}</span>
      {label}
    </div>
  )
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; the trace remains readable without it.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      title={label}
      className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
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
