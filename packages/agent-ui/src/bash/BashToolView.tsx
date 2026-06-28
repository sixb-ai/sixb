import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
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
import {
  type BashIcon,
  type BashIntent,
  classifyCommand,
  coerceBashInput,
  coerceBashOutput,
  describeBash,
  type ParsedBashOutput,
} from "./interpret"
import {
  ActionResultView,
  ActionRunView,
  ApiDataView,
  FacetsView,
  GenericCommandView,
  ObjectDetailView,
  ObjectListView,
  ObjectTypeSchemaView,
  ObjectTypesView,
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
  const input = coerceBashInput(tool.input)
  const command = input?.command ?? tool.inputText ?? ""
  const intent = classifyCommand(command)
  const parsed = coerceBashOutput(tool.output)

  const running = tool.state === "input-streaming" || tool.state === "input-available"
  const isError = tool.state === "output-error" || (parsed !== null && !parsed.ok)
  const description = describeBash(intent, parsed)
  const Icon = ICONS[description.icon]
  const label = running ? description.runningTitle : description.title

  // Failures surface inline — never hidden behind a disclosure.
  if (isError && !running) {
    return (
      <div>
        <ToolLine icon={Terminal} label={label} tone="error" />
        <p className="mt-1.5 border-l-2 border-destructive/30 pl-3 text-xs whitespace-pre-wrap text-destructive">
          {errorMessage(parsed, tool.errorText)}
        </p>
      </div>
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
        <span className={cn("min-w-0 truncate font-medium", running && "shimmer")}>{label}</span>
        {!running && description.detail ? (
          <span className="min-w-0 shrink truncate text-muted-foreground/60">
            {description.detail}
          </span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
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
  tone = "default",
  running,
}: {
  icon: LucideIcon
  label: string
  detail?: string
  tone?: "default" | "error"
  running?: boolean
}) {
  return (
    <div
      className={cn(
        "flex w-fit max-w-full items-center gap-1.5 text-[13px] leading-normal",
        tone === "error" ? "text-destructive" : "text-muted-foreground"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className={cn("min-w-0 truncate font-medium", running && "shimmer")}>{label}</span>
      {detail ? (
        <span className="min-w-0 shrink truncate text-muted-foreground/60">{detail}</span>
      ) : null}
    </div>
  )
}

/** Results whose headline already says everything — no expandable body needed. */
function isLeafResult(intent: BashIntent, running: boolean): boolean {
  if (running) return false
  return (
    intent.kind === "api-count" ||
    intent.kind === "api-exists" ||
    intent.kind === "api-telemetry-latest"
  )
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
    // Still running — show the command being run, nothing else.
    return command ? (
      <pre className="overflow-x-auto rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="select-none text-muted-foreground/50">$ </span>
        {command}
      </pre>
    ) : null
  }

  switch (intent.kind) {
    case "api-object-types":
      return <ObjectTypesView parsed={parsed} />
    case "api-objects-list":
    case "api-objects-query":
      return <ObjectListView parsed={parsed} />
    case "api-object-detail":
      return <ObjectDetailView parsed={parsed} />
    case "api-object-type-detail":
      return <ObjectTypeSchemaView parsed={parsed} />
    case "api-facets":
      return <FacetsView parsed={parsed} />
    case "api-telemetry-history":
      return <TelemetryHistoryView parsed={parsed} />
    case "api-telemetry-bulk":
      return <TelemetryBulkView parsed={parsed} />
    case "api-action-request":
      return <ActionResultView parsed={parsed} />
    case "api-action-run":
      return <ActionRunView parsed={parsed} />
    case "generic":
      return <GenericCommandView parsed={parsed} command={command} />
    // Remaining surfaces (actions list, project info) render through the neutral data view —
    // structured, never raw JSON.
    default:
      return <ApiDataView parsed={parsed} />
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
