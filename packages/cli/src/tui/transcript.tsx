/** @jsxImportSource @opentui/react */
import { CodeRenderable, type MarkdownOptions, type SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import type { ListAgentThreadApprovalsResponses, ListAgentThreadRunsResponses } from "@sixb/client"
import { useEffect, useState } from "react"
import { duration, friendlyPath, plural, runFailureText, type ToolLine, toolLine } from "./format"
import { steadyMarkdown } from "./markdown"
import {
  type ApprovalOutcome,
  approvalOutcomes,
  type LiveRun,
  type Part,
  type ShownMessage,
} from "./parts"
import { placeLabel } from "./settings"
import type { TuiColors } from "./theme"
import { BOLD, ITALIC, useNow, useSpinner } from "./ui"

export type Run = ListAgentThreadRunsResponses[200]["runs"][number]
export type Approval = ListAgentThreadApprovalsResponses[200]["approvals"][number]

/** How a turn's model is named under its answer: its catalog name, else its id. */
export type ModelNames = ReadonlyMap<string, string>

const TIER_NAMES = { light: "Light", standard: "Standard", heavy: "Heavy" } as const

export function Transcript({
  colors,
  syntax,
  messages,
  runs,
  live,
  approvals,
  modelNames,
  computerRuns,
  width,
  folder,
  approvalChoice,
}: {
  readonly colors: TuiColors
  readonly syntax: SyntaxStyle
  readonly messages: readonly ShownMessage[]
  readonly runs: readonly Run[]
  readonly live: LiveRun | null
  readonly approvals: readonly Approval[]
  readonly modelNames: ModelNames
  /** Whether the thread's turns run on its owner's computer. */
  readonly computerRuns: boolean
  /** The terminal's width: rows that must stay one line are cut to it. */
  readonly width: number
  /** The folder a computer's turns work in: paths in it are shown relative to it. */
  readonly folder?: string
  /** The choice the first waiting call's card shows chosen. */
  readonly approvalChoice: number
}) {
  const runsById = new Map(runs.map((run) => [run.id, run]))
  const outcomes = approvalOutcomes(messages)
  // A resumed turn's trigger only says how its held calls ended, which their own lines show.
  const shown = messages.filter((message) => message.role !== "user" || message.parts.length > 0)
  // The live run shows its own answer until the stored one arrives, never both.
  const liveShown =
    live &&
    !messages.some((message) => message.runId === live.runId && message.role === "assistant")
  return (
    <box flexDirection="column" gap={1}>
      {shown.map((message, index) => {
        if (message.role === "user")
          return <UserMessage key={message.id} colors={colors} message={message} />
        const next = shown[index + 1]
        // A turn's meta goes under its last message: a resumed turn answers in several.
        const lastOfRun = !next || next.runId !== message.runId
        const run = message.runId ? runsById.get(message.runId) : undefined
        return (
          <box key={message.id} flexDirection="column" gap={1}>
            <AgentParts
              colors={colors}
              syntax={syntax}
              parts={message.parts}
              outcomes={outcomes}
              streaming={false}
              width={width}
              folder={folder}
            />
            {lastOfRun && run && run.status !== "running" && run.status !== "queued" ? (
              <RunMeta
                colors={colors}
                run={run}
                modelNames={modelNames}
                computerRuns={computerRuns}
                waiting={approvals.some((approval) => approval.runId === run.id)}
              />
            ) : null}
          </box>
        )
      })}
      {liveShown && live ? (
        <AgentParts
          colors={colors}
          syntax={syntax}
          parts={live.parts}
          outcomes={outcomes}
          streaming={live.working}
          width={width}
          folder={folder}
        />
      ) : null}
      {approvals.map((approval, index) => (
        <ApprovalCard
          key={approval.id}
          colors={colors}
          approval={approval}
          {...(index === 0 ? { choice: approvalChoice } : {})}
        />
      ))}
    </box>
  )
}

function UserMessage({
  colors,
  message,
}: {
  readonly colors: TuiColors
  readonly message: ShownMessage
}) {
  return (
    <box
      border={["left"]}
      borderStyle="heavy"
      borderColor={colors.blue}
      backgroundColor={colors.surface}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
    >
      {message.parts.map((part, index) =>
        part.kind === "text" ? (
          <text key={`${message.id}-${index}`} fg={colors.text}>
            {part.text.trim()}
          </text>
        ) : part.kind === "file" ? (
          <text key={`${message.id}-${index}`}>
            <span fg={colors.faint}>{"▱ "}</span>
            <span fg={colors.muted}>{part.name}</span>
          </text>
        ) : null
      )}
    </box>
  )
}

/** The agent's side of a turn: what it said, what it thought, and every call it made. */
function AgentParts({
  colors,
  syntax,
  parts,
  outcomes,
  streaming,
  width,
  folder,
}: {
  readonly colors: TuiColors
  readonly syntax: SyntaxStyle
  readonly parts: readonly Part[]
  /** How the transcript's held calls ended, by approval id. */
  readonly outcomes: ReadonlyMap<string, ApprovalOutcome>
  readonly streaming: boolean
  readonly width: number
  readonly folder?: string
}) {
  return (
    <box flexDirection="column" paddingLeft={3} paddingRight={2} gap={1}>
      {parts.map((part, index) => {
        const key = part.kind === "tool" ? part.id : `${part.kind}-${index}`
        const last = index === parts.length - 1
        switch (part.kind) {
          case "text":
            return (
              <Answer
                key={key}
                colors={colors}
                syntax={syntax}
                text={part.text}
                streaming={streaming && last}
              />
            )
          case "reasoning":
            // A model that keeps its thinking to itself sends it without text: nothing to show.
            if (!part.text.trim()) return null
            return (
              <Thought
                key={key}
                colors={colors}
                text={part.text}
                done={part.done || !streaming}
                width={width}
              />
            )
          case "tool":
            return (
              <ToolRow
                key={key}
                colors={colors}
                line={shownLine(toolLine(part, outcomes), folder)}
                state={part.state}
                width={width}
              />
            )
          default:
            return (
              <text key={key}>
                <span fg={colors.faint}>{"▱ "}</span>
                <span fg={colors.muted}>{part.name}</span>
              </text>
            )
        }
      })}
    </box>
  )
}

/**
 * What the agent said, as markdown drawn the moment it is set: each top-level block on its own,
 * where OpenTUI otherwise draws runs of them as raw markdown until highlighting conceals the
 * markers, every time the text grows. While it streams, its unfinished end is steadied.
 */
function Answer({
  colors,
  syntax,
  text,
  streaming,
}: {
  readonly colors: TuiColors
  readonly syntax: SyntaxStyle
  readonly text: string
  readonly streaming: boolean
}) {
  // Markdown created finished draws nothing until it is highlighted, and an answer is created
  // finished whenever its stored message replaces the streamed one. Created streaming it is drawn
  // at once, so a finished answer is finalized after its first frame.
  const renderer = useRenderer()
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const mark = () => setDrawn(true)
    renderer.once("frame", mark)
    return () => {
      renderer.off("frame", mark)
    }
  }, [renderer])

  return (
    <markdown
      content={streaming ? steadyMarkdown(text) : text.trim()}
      syntaxStyle={syntax}
      fg={colors.text}
      conceal
      internalBlockMode="top-level"
      tableOptions={TABLES}
      renderNode={drawCodeAtOnce}
      streaming={streaming || !drawn}
    />
  )
}

/** Tables boxed, as the transcript has always drawn them. */
const TABLES: MarkdownOptions["tableOptions"] = { style: "grid" }

type RenderNode = NonNullable<MarkdownOptions["renderNode"]>

/**
 * A code block drawn plain until it is highlighted, rather than left blank. Only code blocks: the
 * rest keeps OpenTUI's own rendering.
 */
const drawCodeAtOnce = Object.assign<RenderNode, { codeBlockOnly: true }>(
  (token, context) => {
    if (token.type !== "code") return undefined
    const code = context.defaultRender()
    if (code instanceof CodeRenderable) code.drawUnstyledText = true
    return code
  },
  { codeBlockOnly: true }
)

function Thought({
  colors,
  text,
  done,
  width,
}: {
  readonly colors: TuiColors
  readonly text: string
  readonly done: boolean
  readonly width: number
}) {
  const lines = text
    .trim()
    .split("\n")
    .filter((line) => line.trim())
  const room = Math.max(20, width - 14)
  // Its first lines once done, its latest while it thinks; never more than a few.
  const shown = done ? lines.slice(0, THOUGHT_LINES) : lines.slice(-THOUGHT_LINES)
  const more = lines.length - shown.length
  return (
    <box border={["left"]} borderColor={colors.border} paddingLeft={2} flexDirection="column">
      <text fg={colors.muted} attributes={ITALIC}>
        {done ? "Thought" : "Thinking…"}
      </text>
      {shown.map((line, index) => (
        <text key={`${index}-${line.slice(0, 8)}`} fg={colors.faint}>
          {oneLine(line, room)}
        </text>
      ))}
      {done && more > 0 ? <text fg={colors.faint}>{`… ${plural(more, "more line")}`}</text> : null}
    </box>
  )
}

const THOUGHT_LINES = 4

/** A line cut to `room` columns, so it never wraps. */
function oneLine(text: string, room: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > room ? `${flat.slice(0, room - 1)}…` : flat
}

function ToolRow({
  colors,
  line,
  state,
  width,
}: {
  readonly colors: TuiColors
  readonly line: ToolLine
  readonly width: number
  readonly state: Extract<Part, { kind: "tool" }>["state"]
}) {
  const spinner = useSpinner(state === "running")
  const room = Math.max(20, width - 16)
  const failed = line.failed || state === "error"
  const tone = line.held ? colors.amber : failed ? colors.red : colors.faint
  if (line.command !== undefined) {
    return <CommandPanel colors={colors} line={line} running={state === "running"} room={room} />
  }
  const mark = state === "running" ? spinner : "●"
  const markColor =
    state === "running"
      ? colors.blue
      : line.held
        ? colors.amber
        : failed
          ? colors.red
          : colors.green
  return (
    <box flexDirection="column">
      <text>
        <span fg={markColor}>{`${mark} `}</span>
        <span fg={colors.text} attributes={BOLD}>
          {line.verb}
        </span>
        <span fg={colors.muted}>
          {line.detail
            ? `  ${oneLine(line.detail, room - line.verb.length - (line.note?.length ?? 0) - 6)}`
            : ""}
        </span>
        {line.note ? <span fg={tone}>{`  ${line.note}`}</span> : null}
      </text>
      {line.preview?.map((row, index) => (
        <text key={`${index}-${row.slice(0, 12)}`}>
          <span fg={colors.faint}>{index === 0 ? "  ⎿ " : "    "}</span>
          <span fg={colors.faint}>{oneLine(row, room)}</span>
        </text>
      ))}
    </box>
  )
}

/** A shell command as its own panel: the command, what it printed, and how it ended. */
function CommandPanel({
  colors,
  line,
  running,
  room,
}: {
  readonly colors: TuiColors
  readonly line: ToolLine
  readonly running: boolean
  readonly room: number
}) {
  const spinner = useSpinner(running)
  const commandLines = (line.command ?? "").split("\n")
  const shown = commandLines.slice(0, COMMAND_LINES)
  const tone = line.held ? colors.amber : line.failed ? colors.red : colors.faint
  const status = running ? spinner : (line.note ?? "")
  return (
    <box
      backgroundColor={colors.surface}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      flexDirection="column"
    >
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="column" flexShrink={1}>
          {shown.map((row, index) => (
            <text key={`${index}-${row.slice(0, 12)}`} wrapMode="none">
              <span fg={colors.blue}>{index === 0 ? "$ " : "  "}</span>
              <span fg={colors.text}>{oneLine(row, room - status.length - 6)}</span>
            </text>
          ))}
          {commandLines.length > shown.length ? (
            <text
              fg={colors.faint}
            >{`  … ${plural(commandLines.length - shown.length, "more line")}`}</text>
          ) : null}
        </box>
        {status ? (
          <text fg={running ? colors.blue : tone} flexShrink={0}>
            {status}
          </text>
        ) : null}
      </box>
      {line.preview && line.preview.length > 0 ? (
        <box flexDirection="column" paddingTop={1}>
          {line.preview.map((row, index) => (
            <text key={`${index}-${row.slice(0, 12)}`} fg={colors.muted} wrapMode="none">
              {oneLine(row, room - 4)}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  )
}

const COMMAND_LINES = 3

/** Under a turn's answer: where it ran, on which model, and how long it took. */
function RunMeta({
  colors,
  run,
  modelNames,
  computerRuns,
  waiting,
}: {
  readonly colors: TuiColors
  readonly run: Run
  readonly modelNames: ModelNames
  readonly computerRuns: boolean
  /** One of its calls still waits for the person. */
  readonly waiting: boolean
}) {
  const model = run.model
    ? (modelNames.get(`${run.model.provider}:${run.model.modelId}`) ?? run.model.modelId)
    : undefined
  const took =
    run.startedAt && run.completedAt
      ? duration(Date.parse(run.completedAt) - Date.parse(run.startedAt))
      : undefined
  const ended =
    run.status === "cancelled"
      ? run.finishReason === "interrupted"
        ? "interrupted"
        : "stopped"
      : run.status === "failed"
        ? "failed"
        : run.finishReason === "awaiting_approval" && waiting
          ? "waiting for you"
          : undefined
  const items = [run.tier ? TIER_NAMES[run.tier] : undefined, model, took].filter(
    (item): item is string => Boolean(item)
  )
  return (
    <text>
      <span fg={colors.blue}>{"   ▰ "}</span>
      <span fg={colors.text}>{placeLabel(computerRuns ? "computer" : "cloud")}</span>
      {items.map((item) => (
        <span key={item} fg={colors.muted}>{` · ${item}`}</span>
      ))}
      {ended ? (
        <span fg={run.status === "failed" ? colors.red : colors.amber}>{` · ${ended}`}</span>
      ) : null}
      {run.status === "failed" && run.error ? (
        <span fg={colors.faint}>{`  ${runFailureText(run.error)}`}</span>
      ) : null}
    </text>
  )
}

/** How a call waiting for the person can be decided, in the order the card offers them. */
export const APPROVAL_CHOICES = [
  { key: "y", label: "Allow", decision: "approve", always: false },
  { key: "a", label: "Always in this thread", decision: "approve", always: true },
  { key: "n", label: "Deny", decision: "deny", always: false },
] as const

/** A call waiting for the person: what it would do, and the choices that decide it. */
function ApprovalCard({
  colors,
  approval,
  choice,
}: {
  readonly colors: TuiColors
  readonly approval: Approval
  /** The choice enter would make; absent on a card that is not the one being decided. */
  readonly choice?: number
}) {
  const { call } = approval
  const title =
    call.kind === "action"
      ? `Run ${call.actionId}${call.subject.kind === "object" ? ` on ${call.subject.objectTypeId} ${call.subject.primaryId}` : ""}?`
      : `Start the ${call.workflowId} workflow?`
  const input = JSON.stringify(call.kind === "action" ? call.params : call.input)
  const external = call.kind === "action" && call.effect === "external"
  return (
    <box
      border={["left"]}
      borderStyle="heavy"
      borderColor={colors.amber}
      backgroundColor={colors.surface}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      marginLeft={3}
      flexDirection="column"
    >
      <text>
        <span fg={colors.amber}>{"? "}</span>
        <span fg={colors.text} attributes={BOLD}>
          {title}
        </span>
        {external ? <span fg={colors.muted}>{"  reaches outside Sixb"}</span> : null}
      </text>
      {input && input !== "{}" ? (
        <text fg={colors.faint}>{input.length > 220 ? `${input.slice(0, 217)}…` : input}</text>
      ) : null}
      <box height={1} />
      <text>
        {APPROVAL_CHOICES.map((option, index) => {
          const chosen = index === choice
          return (
            <span key={option.key}>
              {index > 0 ? "    " : ""}
              <span fg={chosen ? colors.amber : colors.faint}>{chosen ? "▸ " : "  "}</span>
              <span fg={chosen ? colors.text : colors.muted} attributes={chosen ? BOLD : 0}>
                {option.label}
              </span>
              <span fg={colors.faint}>{` ${option.key}`}</span>
            </span>
          )
        })}
      </text>
    </box>
  )
}

/** While a turn works: the spinner, how long, and how to stop it. */
export function Working({
  colors,
  since,
  label,
  stopping = false,
}: {
  readonly colors: TuiColors
  readonly since: number
  readonly label: string
  /** Waiting for a second esc: the hint is the label then. */
  readonly stopping?: boolean
}) {
  const now = useNow(120)
  return (
    <text>
      <span>{"   "}</span>
      <Wave colors={colors} at={now} />
      <span fg={colors.text}>{`  ${label}`}</span>
      <span fg={colors.faint}>{`  ${duration(Math.max(0, now - since))}`}</span>
      {stopping ? null : <span fg={colors.faint}>{"   esc to stop"}</span>}
    </text>
  )
}

/** A call's line with its paths as the person reads them. */
function shownLine(line: ToolLine, folder?: string): ToolLine {
  return {
    ...line,
    detail: friendlyPath(line.detail, folder),
    ...(line.command === undefined ? {} : { command: friendlyPath(line.command, folder) }),
  }
}

const WAVE_TILES = 4

/**
 * The mosaic at work: a tile in each of its blues, the brightest moving along them, as the
 * website's hero fills.
 */
function Wave({ colors, at }: { readonly colors: TuiColors; readonly at: number }) {
  const lead = Math.floor(at / 120) % (WAVE_TILES * 2 - 2)
  const position = lead < WAVE_TILES ? lead : WAVE_TILES * 2 - 2 - lead
  return (
    <>
      {Array.from({ length: WAVE_TILES }, (_, index) => {
        const distance = Math.abs(index - position)
        const color =
          distance === 0
            ? colors.blue
            : (colors.water[Math.max(0, colors.water.length - 1 - distance)] ?? colors.faint)
        return (
          <span key={index} fg={distance > 2 ? colors.border : color}>
            {distance === 0 ? "▰" : "▱"}
          </span>
        )
      })}
    </>
  )
}
