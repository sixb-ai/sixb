import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { BookmarkCheck, ChevronRight, FileX, Wrench } from "lucide-react"
import { memo, useState } from "react"
import { ReferencingMarkdown } from "../../artifacts/references/references"
import { latestWorkLabel } from "../activity-label"
import { heldCallsInParts } from "../approvals"
import { ArtifactCards } from "../artifact-card"
import { generatedMedia } from "../bash/bash-tool-view"
import { savedMemories } from "../bash/interpret"
import { ModelMediaView } from "../bash/model-media-view"
import { ChildCards } from "../delegation/child-cards"
import { describeDelegationTool, spawnedChildren } from "../delegation/interpret"
import { useAgentMessages } from "../i18n"
import { childQuestions, describeMessageAgent } from "../message-agent/interpret"
import { type NormalizedPart, type NormalizedTool, toolResultValue } from "../parts"
import { turnArtifacts, unpublishedTitles } from "../publish-artifact/interpret"
import { builtInToolView } from "../tool-views/built-in"
import { AnswerToolViews, ProjectToolView, useAgentToolView } from "../tool-views/registry"
import { coerceWebSearchOutput, collectWebSources } from "../utils/web-search"
import { ACTIVITY_STATUS_ROW_CLASS_NAME, ActivityStatusText } from "./activity-status"
import { ApprovalCards } from "./approval-card"
import { FileAttachmentCard } from "./file-attachment-card"
import { WebSources } from "./web-sources"

/** Calls a sub-agent's row stands for, in the conversation and in its thread. */
const DELEGATION_ROW_TOOLS: ReadonlySet<string> = new Set(["spawn_agent", "wait_agent"])

/**
 * Render an assistant body from normalized parts. Narration text stays on the main reading path;
 * every run of consecutive reasoning + tool parts collapses into a single "work" disclosure, so a
 * long chain of thinking and tool calls reads as one quiet line above the answer instead of a stack
 * of separate dropdowns. What the turn published closes the body as one row of cards, while each
 * publish keeps its row in the work; the project's tool views placed in the answer come just
 * before, the same way. A call held for the user's approval shows as a card right under the work
 * that made it, where the reader decides on it, and so does each sub-agent the work spawned.
 * `step-start` markers are intentionally skipped.
 */
export function AssistantBody({
  parts,
  live = false,
  nested = false,
}: {
  parts: readonly NormalizedPart[]
  /** True while this body is driven by an in-flight run, so its headline shows live progress. */
  live?: boolean
  /**
   * A sub-agent's work inside its card: its work reads open, and its calls held for approval are
   * on the card already.
   */
  nested?: boolean
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
    blocks.push(<TextBlock key={`block-${key++}`} text={text} nested={nested} />)
  }

  const flushWork = (inProgress: boolean) => {
    if (workBuffer.length === 0) return
    const work = workBuffer
    workBuffer = []
    // Starting and awaiting sub-agents is what their line shows, and a call held for approval is
    // what its card shows: the work line leaves them out — but not a wait that brought back a
    // question, which the work keeps on record — and a run of nothing else, or of only step
    // boundaries, has no line at all.
    const shown = work.filter(
      (part) =>
        !(
          part.kind === "tool" &&
          ((DELEGATION_ROW_TOOLS.has(part.tool.toolName) &&
            childQuestions(part.tool).length === 0) ||
            (!nested && heldCallsInParts([part]).length > 0))
        )
    )
    if (shown.some((part) => part.kind !== "step-start")) {
      blocks.push(
        <WorkGroup key={`block-${key++}`} parts={shown} inProgress={inProgress} nested={nested} />
      )
    }
    if (nested) return

    const held = heldCallsInParts(work)
    if (held.length > 0) blocks.push(<ApprovalCards key={`approvals-${key++}`} calls={held} />)
    const spawned = spawnedChildren(work)
    if (spawned.length > 0) blocks.push(<ChildCards key={`children-${key++}`} spawned={spawned} />)
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
  blocks.push(<AnswerToolViews key="answer-tools" parts={parts} />)
  const artifacts = turnArtifacts(parts)
  if (artifacts.length > 0) blocks.push(<ArtifactCards key="artifacts" artifacts={artifacts} />)
  // Saving is work the reply keeps quiet about; what was remembered is the user's to see.
  savedMemories(parts).forEach((save, index) => {
    blocks.push(<SavedToMemory key={`memory:${index}`} {...save} />)
  })
  // Said where the card would be, whatever the answer claims. A live turn may still retry.
  if (!live) {
    for (const title of unpublishedTitles(parts)) {
      blocks.push(<NotPublished key={`unpublished:${title}`} title={title} />)
    }
  }

  return <div className="flex flex-col gap-3">{blocks}</div>
}

function SavedToMemory({ repo, message }: { repo: "user" | "project"; message: string }) {
  const messages = useAgentMessages().memory
  return (
    <p
      className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground"
      role="status"
    >
      <BookmarkCheck className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">{messages.saved(repo === "project")}</span>
      <span className="min-w-0 truncate text-muted-foreground/70" title={message}>
        · {message}
      </span>
    </p>
  )
}

function NotPublished({ title }: { title: string }) {
  const messages = useAgentMessages().artifacts
  return (
    <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground" role="status">
      <FileX className="size-3.5 shrink-0" aria-hidden="true" />
      {messages.publishFailed(title)}
    </p>
  )
}

// A reply can show or link to an artifact; the panel around the conversation says where it opens.
const TextBlock = memo(function TextBlock({ text, nested }: { text: string; nested: boolean }) {
  return (
    // `.prose` sets its own size outside Tailwind's layers: only an important size wins over it.
    <ReferencingMarkdown className={cn("prose-chat", nested && "text-sm! leading-relaxed!")}>
      {text}
    </ReferencingMarkdown>
  )
})

const FileBlock = memo(function FileBlock({
  part,
}: {
  part: Extract<NormalizedPart, { kind: "file" }>
}) {
  return <FileAttachmentCard fileRef={part.fileRef} source={part.source} />
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
  nested = false,
}: {
  parts: readonly NormalizedPart[]
  inProgress: boolean
  /** In a sub-agent's thread: closed like the chat's own work line, and without a scroll once open. */
  nested?: boolean
}) {
  const messages = useAgentMessages()
  const [open, setOpen] = useState(false)
  const sources = collectWebSources(parts)
  const searches = parts.flatMap((part) =>
    part.kind === "tool" && part.tool.toolName === "web_search" ? [part.tool] : []
  )
  const searchFailed = searches.some((tool) => tool.state === "output-error")
  const emptySearch =
    searches.length > 0 &&
    searches.every(
      (tool) =>
        tool.state === "output-available" && coerceWebSearchOutput(tool.output)?.length === 0
    )

  const made = parts.flatMap((part) => {
    if (part.kind !== "tool" || part.tool.toolName !== "bash") return []
    const media = generatedMedia(part.tool)
    return media ? [media] : []
  })
  const toolCount = parts.reduce((count, part) => count + (part.kind === "tool" ? 1 : 0), 0)
  const hasTools = toolCount > 0
  const liveLabel = latestWorkLabel(parts, messages)
  // Named by what it holds, not in a tense: the same line is read while the turn still works,
  // while it waits on the reader, and once it is done.
  const label = hasTools ? messages.activity.steps(toolCount) : messages.activity.reasoning

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-full">
      <CollapsibleTrigger
        className={cn(
          ACTIVITY_STATUS_ROW_CLASS_NAME,
          "outline-none transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        )}
      >
        {inProgress ? (
          <ActivityStatusText label={liveLabel} className="shimmer motion-reduce:animate-none" />
        ) : (
          <span>{label}</span>
        )}
        <ChevronRight className="size-3.5 shrink-0 opacity-50 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className={cn(
            "mt-2 ml-1 flex flex-col gap-3 border-l border-border py-0.5 pr-2 pl-3.5",
            !nested && "scrollbar-thin max-h-[min(24rem,50vh)] overflow-y-auto overscroll-contain"
          )}
        >
          {parts.map((part, index) => {
            if (part.kind === "reasoning") {
              return <GroupReasoning key={index} text={part.text} streaming={part.streaming} />
            }
            if (part.kind === "tool") {
              return <ToolCallRow key={index} tool={part.tool} parts={parts} />
            }
            return null
          })}
        </div>
      </CollapsibleContent>
      {made.length > 0 ? (
        <div className="mt-3 flex flex-col gap-5">
          {made.map(({ media, running }, index) => (
            <ModelMediaView
              key={media.callId ?? `making:${index}`}
              media={media}
              running={running}
            />
          ))}
        </div>
      ) : null}
      <WebSources sources={sources} />
      {searchFailed || emptySearch ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground" role="status">
          {searchFailed ? messages.activity.searchFailedHint : messages.activity.noSources}
        </p>
      ) : null}
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
 * A single tool call within a work group. A project view placed in the work takes the row; else
 * framework tools render through purpose-built views, and other tools fall back to the generic
 * inspector. All keep their bodies borderless and inline so an expanded result flows within the
 * group rather than reading as a nested dropdown.
 */
function ToolCallRow({
  tool,
  parts,
}: {
  tool: NormalizedTool
  /** The rest of its work, which names the children a wait is for. */
  parts: readonly NormalizedPart[]
}) {
  const view = useAgentToolView(tool.toolName)
  if (view?.placement === "work") {
    return (
      <ProjectToolView
        view={view}
        tool={tool}
        fallback={<BuiltInToolRow tool={tool} parts={parts} />}
      />
    )
  }
  return <BuiltInToolRow tool={tool} parts={parts} />
}

/** A tool call through the framework's view of the tool, else the generic inspector. */
export function BuiltInToolRow({
  tool,
  parts = [],
}: {
  tool: NormalizedTool
  /** The rest of its work, which names the children a wait is for. */
  parts?: readonly NormalizedPart[]
}) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.activity
  const builtIn = builtInToolView(tool)
  if (builtIn !== null) return builtIn

  // A delegation reads as what it does: the cards under the work say the rest, never its JSON.
  const delegation = describeDelegationTool(tool, parts, agentMessages)
  const isError = tool.state === "output-error"
  const hasInput = !delegation && (tool.input !== undefined || Boolean(tool.inputText))
  const hasOutput = !delegation && tool.state === "output-available" && tool.output !== undefined
  const files = tool.files ?? []
  const expandable = hasInput || hasOutput || (isError && !delegation) || files.length > 0
  // A wait that a child's question ended reads as the question, one row for each.
  const [question, ...otherQuestions] = childQuestions(tool)
  const title =
    tool.toolName === "message_agent"
      ? describeMessageAgent(tool, agentMessages).title
      : question
        ? messages.agentAsks(question.key, question.text)
        : (delegation?.title ?? tool.toolName)

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
          <span
            className={cn(
              "min-w-0 font-medium",
              // A sub-agent's question reads in full.
              tool.toolName === "ask_parent" ? "text-left break-words" : "truncate"
            )}
          >
            {title}
          </span>
          <ToolStatus state={tool.state} />
          {expandable ? (
            <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-2">
          {hasInput ? (
            <JsonViewer label={messages.input} value={tool.input ?? tool.inputText} />
          ) : null}
          {hasOutput ? (
            <JsonViewer label={messages.output} value={toolResultValue(tool.output)} />
          ) : null}
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {files.map((file, index) => (
                <FileAttachmentCard
                  key={`${file.fileRef.blobId}:${index}`}
                  fileRef={file.fileRef}
                  source={file.source}
                />
              ))}
            </div>
          ) : null}
          {isError && !delegation ? (
            <JsonViewer label={messages.details} value={tool.errorText || messages.toolFailed} />
          ) : null}
        </CollapsibleContent>
      </Collapsible>
      {otherQuestions.map((other) => (
        <p
          key={`${other.key}:${other.text}`}
          className="mt-1 flex max-w-full items-center gap-1.5 text-[13px] leading-normal font-medium text-muted-foreground"
        >
          <Wrench className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{messages.agentAsks(other.key, other.text)}</span>
        </p>
      ))}
    </div>
  )
}

function ToolStatus({ state }: { state: NormalizedTool["state"] }) {
  // Only the in-flight state is worth a badge; a finished call (done or errored) reads from the
  // marker itself, keeping failures from flashing red in the transcript.
  const messages = useAgentMessages().activity
  const running = state === "input-streaming" || state === "input-available"
  if (!running) return null
  return (
    <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 shimmer">
      {messages.running}
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
