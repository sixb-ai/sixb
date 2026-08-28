import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import {
  Activity,
  BarChart3,
  BookOpen,
  Boxes,
  ChevronRight,
  FileText,
  FolderGit2,
  Hash,
  type LucideIcon,
  Table2,
  Terminal,
  Zap,
} from "lucide-react"
import { useState } from "react"
import { ActivityStatusText } from "../components/ActivityStatus"
import {
  type BashIcon,
  type BashIntent,
  classifyCommand,
  coerceBashInput,
  coerceBashOutput,
  commandPreview,
  describeBash,
  type ParsedBashOutput,
} from "./interpret"
import {
  ActionResultView,
  ActionRunView,
  FacetsView,
  GenericCommandView,
  ObjectDetailView,
  ObjectListView,
  ObjectTypeSchemaView,
  ObjectTypesView,
  StructuredDataView,
  TelemetryBulkView,
  TelemetryHistoryView,
} from "./renderers"

// A render-ready bash tool part, mirroring the fields agent-ui already normalizes for tool calls.
export interface BashTool {
  readonly state: "input-streaming" | "input-available" | "output-available" | "output-error"
  readonly input?: unknown
  readonly inputText?: string
  readonly output?: unknown
  readonly errorText?: string
}

const ICONS: Record<BashIcon, LucideIcon> = {
  ontology: Boxes,
  objects: Table2,
  object: FileText,
  count: Hash,
  facets: BarChart3,
  telemetry: Activity,
  actions: Zap,
  project: FolderGit2,
  skill: BookOpen,
  terminal: Terminal,
}

/**
 * The friendly view of the agent's `bash` tool, styled to sit quietly in the transcript like the
 * reasoning markers — a compact, borderless line that hugs its label. Trivial results (skill reads,
 * counts, existence checks) read fully from the headline; richer results expand into a native view.
 * A "View raw" toggle keeps the underlying payload one click away for developers.
 */
export function BashToolView({ tool }: { tool: BashTool }) {
  if (tool.state === "input-streaming") {
    return <ToolLine icon={Terminal} label="Preparing a command" running />
  }

  const input = coerceBashInput(tool.input)
  const command = input?.command ?? tool.inputText ?? ""
  const intent = classifyCommand(command)
  const parsed = coerceBashOutput(tool.output)

  const running = tool.state === "input-available"
  const isError = tool.state === "output-error" || (parsed !== null && !parsed.ok)
  const description = describeBash(intent, parsed)
  const Icon = ICONS[description.icon]
  const label = running ? description.runningTitle : description.title

  // A failed command reads as a quiet, neutral step — same calm marker as any other tool line, no
  // alarming red in the transcript. The error itself is tucked behind the disclosure so advanced
  // users can still expand and debug it. (Exploratory commands often fail and the agent recovers;
  // surfacing that in red just makes a working run look broken.)
  if (isError && !running) {
    return (
      <Collapsible>
        <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium">{label}</span>
          <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 space-y-2 text-xs">
            {command ? <RawBlock label="Command" value={command} /> : null}
            <RawBlock label="Details" value={errorMessage(parsed, tool.errorText)} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  // These answer fully from the headline (and we never expose internal skill docs), so they render
  // as a plain one-line marker with no disclosure.
  if (intent.kind === "read-skill" || isLeafResult(intent, running)) {
    return (
      <ToolLine
        icon={Icon}
        label={label}
        detail={running ? undefined : description.detail}
        running={running}
      />
    )
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal text-muted-foreground transition-colors hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        {running ? (
          <ActivityStatusText label={label} className="font-medium shimmer" />
        ) : (
          <span className="min-w-0 truncate font-medium">{label}</span>
        )}
        {!running && description.detail ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/60">
            {description.detail}
          </span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 space-y-3 text-xs">
          <BashResult intent={intent} parsed={parsed} command={command} />
          <RawToggle command={command} tool={tool} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A quiet, non-interactive marker row matching the reasoning label style. */
function ToolLine({
  icon: Icon,
  label,
  detail,
  running,
}: {
  icon: LucideIcon
  label: string
  detail?: string
  running?: boolean
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

/** Results whose headline already says everything — no expandable body needed. */
function isLeafResult(intent: BashIntent, running: boolean): boolean {
  if (running || intent.kind !== "sixb") return false
  return ["objects.count", "objects.exists", "telemetry.latest"].includes(intent.command)
}

function BashResult({
  intent,
  parsed,
  command,
}: {
  intent: BashIntent
  parsed: ParsedBashOutput | null
  command: string
}) {
  if (parsed === null) {
    // Still running — keep multiline payloads folded; the raw disclosure retains the full command.
    return command ? (
      <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
        <span className="select-none text-muted-foreground/50">$ </span>
        {commandPreview(command)}
      </pre>
    ) : null
  }

  if (intent.kind === "generic" || intent.kind === "compound") {
    return <GenericCommandView parsed={parsed} command={command} />
  }
  if (intent.kind === "read-skill") return <StructuredDataView parsed={parsed} />

  switch (intent.command) {
    case "ontology.list":
      return <ObjectTypesView parsed={parsed} />
    case "objects.list":
    case "objects.get":
    case "objects.search":
    case "objects.query":
      return <ObjectListView parsed={parsed} />
    case "objects.inspect":
      return <ObjectDetailView parsed={parsed} />
    case "ontology.get":
      return <ObjectTypeSchemaView parsed={parsed} />
    case "objects.facets":
      return <FacetsView parsed={parsed} />
    case "telemetry.history":
      return <TelemetryHistoryView parsed={parsed} />
    case "telemetry.query":
      return <TelemetryBulkView parsed={parsed} />
    case "actions.request":
      return <ActionResultView parsed={parsed} />
    case "action-runs.get":
      return <ActionRunView parsed={parsed} />
    // Remaining CLI surfaces render through the neutral data view — structured, never raw JSON.
    default:
      return <StructuredDataView parsed={parsed} />
  }
}

/** Developer escape hatch: the literal command and output payload, off by default. */
function RawToggle({ command, tool }: { command: string; tool: BashTool }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50 transition-colors hover:text-muted-foreground"
      >
        {open ? "Hide raw" : "View raw"}
      </button>
      {open ? (
        <div className="mt-1.5 space-y-2">
          <RawBlock label="Command" value={command} />
          {tool.output !== undefined ? (
            <RawBlock label="Output" value={format(tool.output)} />
          ) : null}
          {tool.errorText ? <RawBlock label="Error" value={tool.errorText} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function RawBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {label}
      </p>
      <pre className="scrollbar-thin max-h-60 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-foreground">
        {value}
      </pre>
    </div>
  )
}

function errorMessage(parsed: ParsedBashOutput | null, errorText: string | undefined): string {
  if (parsed) return parsed.stderr.trim() || parsed.stdout.trim() || "The command failed."
  return errorText?.trim() || "The command failed."
}

function format(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
