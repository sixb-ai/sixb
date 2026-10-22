import {
  CLI_EXAMPLES,
  type CliHelp,
  type CliHelpItem,
  ROOT_HELP,
  ROOT_HELP_GROUPS,
} from "../lib/command-line"
import {
  commands,
  contentWidth,
  header,
  headline,
  hints,
  marked,
  pad,
  paragraph,
  plural,
  quoted,
  type Row,
  rows,
  type Status,
  screen,
  section,
  stack,
  table,
  visibleWidth,
  warnings as warningLines,
  wrap,
} from "./layout"
import { colorLevel, glyph, paint, palette, tone } from "./theme"

export type KeyValueItem = { label: string; value: string }

const DOCS_URL = "https://docs.sixb.ai"

// Every screen reads top to bottom the same way: the `▰ sixb <command>` header, the details, then
// the outcome. A command that has one thing to say says it on one line instead.

// ─── Help ────────────────────────────────────────────────────────────────────

/** Past this, a command or option gets its own line and its description starts under it. */
const HELP_LABEL_COLUMN = 26

/**
 * Help reads by name: the command or option stands out, what it does stays quiet, and a default
 * sits apart from the description so the eye can skip it. `column` lines several groups up on
 * one column; without it, the column fits these items, up to `HELP_LABEL_COLUMN`.
 */
function helpRows(items: readonly CliHelpItem[], column?: number): string {
  const width =
    column ??
    Math.min(HELP_LABEL_COLUMN, Math.max(...items.map((item) => visibleWidth(item.label))) + 2)
  const room = Math.max(20, contentWidth() - width)
  const hanging = " ".repeat(width)
  return items
    .map((item) => {
      const match = /\s*\(default:?\s*([^)]*)\)$/.exec(item.value)
      const summary = match ? item.value.slice(0, match.index) : item.value
      const lines = wrap(summary, room).map((line) => tone.muted(line))
      if (match) lines[lines.length - 1] += tone.faint(`  default ${match[1]}`)
      if (visibleWidth(item.label) + 2 > width) {
        return [item.label, ...lines.map((line) => `${hanging}${line}`)].join("\n")
      }
      const [first = "", ...rest] = lines
      return [`${pad(item.label, width)}${first}`, ...rest.map((line) => `${hanging}${line}`)].join(
        "\n"
      )
    })
    .join("\n")
}

export function versionView(version: string): string {
  return `${version}\n`
}

export function helpView({ errorMessage }: { errorMessage?: string } = {}): string {
  const column =
    Math.max(
      ...ROOT_HELP_GROUPS.filter((group) => !group.compact).flatMap((group) =>
        group.items.map((item) => visibleWidth(item.label))
      )
    ) + 2
  return screen(
    header("", ROOT_HELP.summary),
    errorMessage ? headline("fail", errorMessage) : null,
    section("Usage", `${tone.faint("$")} ${ROOT_HELP.usage}`),
    ...ROOT_HELP_GROUPS.map((group) =>
      section(
        group.title,
        group.compact
          ? // A family of commands that each have their own help: their names are enough here.
            paragraph(group.items.map((item) => item.label.split(" ")[0]).join("  "))
          : helpRows(group.items, column)
      )
    ),
    section("Options", helpRows(ROOT_HELP.options, column)),
    section("Examples", commands(CLI_EXAMPLES)),
    `${tone.muted("Run")} sixb <command> --help ${tone.muted("for its options.")}  ${tone.muted("Docs")} ${tone.url(DOCS_URL)}`
  )
}

export function commandHelpView({
  help,
  errorMessage,
}: {
  help: CliHelp
  errorMessage?: string
}): string {
  return screen(
    stack(header(help.path.join(" ")), tone.muted(help.summary)),
    errorMessage ? headline("fail", errorMessage) : null,
    section("Usage", `${tone.faint("$")} ${help.usage}`),
    help.commands.length > 0 ? section("Commands", helpRows(help.commands)) : null,
    help.options.length > 0 ? section("Options", helpRows(help.options)) : null
  )
}

// ─── Results ─────────────────────────────────────────────────────────────────

export function errorView({
  title,
  message,
  remediation,
  details = [],
}: {
  title?: string
  message: string
  /** What to do next. Rendered apart from the diagnosis, not appended to it. */
  remediation?: string
  details?: readonly string[]
}): string {
  const width = contentWidth() - 2
  // `[SixbCLI]` and its kin say which package spoke, which a log needs and a person reading a
  // terminal does not. Piped output keeps it.
  const shown = colorLevel() > 0 ? message.replace(/^\[Sixb[A-Za-z]*\]\s+/, "") : message
  const titled = Boolean(title && title !== "Error")
  return screen(
    stack(
      titled
        ? marked(tone.fail(glyph.fail), title ?? "", (line) =>
            paint(line, { color: palette.red, bold: true })
          )
        : marked(tone.fail(glyph.fail), shown, tone.strong),
      ...(titled ? wrap(shown, width).map((line) => `  ${line}`) : [])
    ),
    details.length > 0 ? quoted(details) : null,
    remediation ? rows([{ label: "Try this", value: remediation }]) : null
  )
}

const TITLE_STATUS = { green: "ok", yellow: "warn", red: "fail" } as const

export function keyValueResultView({
  title,
  subtitle,
  items,
  titleColor = "green",
  message,
}: {
  title: string
  subtitle?: string
  items: readonly KeyValueItem[]
  titleColor?: "green" | "yellow" | "red"
  message?: string
}): string {
  return screen(
    header(undefined, subtitle),
    rows(items),
    headline(TITLE_STATUS[titleColor], title),
    message ? paragraph(message, tone.muted) : null
  )
}

/** A list. The header names the command, which already says what the list is. */
export function tableResultView({
  subtitle,
  headers,
  rows: cells,
  emptyMessage,
}: {
  subtitle?: string
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  emptyMessage: string
}): string {
  return screen(
    header(undefined, subtitle),
    cells.length > 0 ? table(headers, cells) : tone.muted(emptyMessage)
  )
}

export function secretResultView({
  title,
  subtitle,
  items,
  secretLabel = "Token",
  secret,
  message = "Store this token now. Sixb will not show it again.",
}: {
  title: string
  subtitle?: string
  items: readonly KeyValueItem[]
  secretLabel?: string
  secret: string
  message?: string
}): string {
  return screen(
    header(undefined, subtitle),
    rows(items),
    headline("ok", title),
    stack(tone.muted(secretLabel), paint(secret, { color: palette.blue, bold: true })),
    message ? marked(tone.warn(glyph.warn), message, tone.warn) : null
  )
}

// ─── Roles ───────────────────────────────────────────────────────────────────

const RUNNING = `${tone.blue(glyph.live)} ${tone.strong("running")}`

/**
 * A long-running role, once started: what it serves, then the hint to stop it. Its logs follow
 * underneath.
 */
export function roleView({
  command,
  name,
  items,
  storage,
  warnings = [],
}: {
  /** The command that started it, such as `api` or `worker-group`. */
  command: string
  name: string
  items: readonly KeyValueItem[]
  storage?: string | null
  warnings?: readonly string[]
}): string {
  return screen(
    header(command, name, RUNNING),
    rows([...items, ...(storage ? [{ label: "storage", value: storage }] : [])]),
    warningLines(warnings),
    hints([["ctrl+c", "stop"]])
  )
}

export function workerItems(
  workers: readonly { readonly type: string; readonly concurrency: number }[]
): KeyValueItem[] {
  return workers.map((worker) => ({
    label: worker.type,
    value: `concurrency ${worker.concurrency}`,
  }))
}

export function devView({
  name,
  apiUrl,
  apiDocsUrl,
  wsUrl,
  appUrl,
  workers = [],
  warnings = [],
}: {
  name: string
  apiUrl: string
  apiDocsUrl: string
  wsUrl: string
  /** `null` when the app could not start; a warning says why. */
  appUrl: string | null
  workers?: readonly { readonly type: string; readonly concurrency: number }[]
  warnings?: readonly string[]
}): string {
  return screen(
    header("dev", name, `${tone.blue(glyph.live)} ${tone.strong("ready")}`),
    rows([
      { label: "app", value: appUrl ?? "not running" },
      { label: "api", value: apiUrl },
      { label: "docs", value: apiDocsUrl },
      { label: "events", value: wsUrl },
      ...(workers.length > 0
        ? [
            {
              label: "workers",
              value: workers.map((worker) => `${worker.type} ${worker.concurrency}`).join(" · "),
            },
          ]
        : []),
    ]),
    warningLines(warnings),
    hints([["ctrl+c", "stop"]])
  )
}

// ─── Project commands ────────────────────────────────────────────────────────

interface Probe {
  ok: boolean
  warning?: boolean
  message?: string
}

export function checkView({
  projectId,
  storage,
  timeseries,
  broker,
  queues,
  projectValidation,
  markings,
  ontology,
  warnings,
}: {
  projectId: string
  storage: Probe
  timeseries: Probe
  broker: Probe
  queues: Probe
  projectValidation?: Probe
  /**
   * The pipeline markings preflight: what SQL steps derive, checked against projections. A warning
   * reports projections whose applied version adds markings the code no longer declares.
   */
  markings?: Probe
  ontology?: { enabled: boolean; source: string; errors: number; warnings: number }
  warnings: readonly string[]
}): string {
  const validation = projectValidation ?? { ok: true }
  const ontologyOk = (ontology?.errors ?? 0) === 0
  const markingsCheck = markings ?? { ok: true }
  const healthy =
    [storage, timeseries, broker, queues, validation, markingsCheck].every((row) => row.ok) &&
    ontologyOk

  // The message wins when there is one, pass or fail: a probe that succeeded still says which
  // provider answered and whether its schema is current. A bare "ok" the mark already says.
  const probe = (label: string, row: Probe): Row => ({
    label,
    status: !row.ok ? "fail" : row.warning ? "warn" : "ok",
    value: (row.message ?? (row.ok ? "" : "failed")).replace(/^ok( · )?/, ""),
  })
  const problems = warnings.length
  return screen(
    header("check", projectId),
    rows([
      probe("Storage", storage),
      probe("Timeseries", timeseries),
      probe("Broker", broker),
      probe("Queues", queues),
      probe("Project", validation),
      probe("Markings", markingsCheck),
      ...(ontology
        ? [
            {
              label: "Ontology",
              status: (ontologyOk ? "ok" : "fail") as Status,
              value: `${plural(ontology.errors, "error")} · ${plural(ontology.warnings, "warning")}`,
              note: relativePath(ontology.source),
            },
          ]
        : []),
    ]),
    warningLines(warnings),
    healthy
      ? headline(
          "ok",
          `${projectId} is healthy`,
          problems > 0 ? plural(problems, "warning") : undefined
        )
      : headline("fail", `${projectId} has issues`)
  )
}

export function buildView({ outdir, seconds }: { outdir: string; seconds?: number }): string {
  return screen(
    headline(
      "ok",
      seconds === undefined ? "Built" : `Built in ${seconds.toFixed(1)}s`,
      undefined,
      relativePath(outdir)
    )
  )
}

export function typegenView({
  path,
  objectTypes,
  skipped,
  written,
}: {
  path: string
  objectTypes: number
  skipped: boolean
  written: boolean
}): string {
  return screen(
    headline(
      skipped ? "idle" : "ok",
      `Ontology types ${skipped ? "skipped" : written ? "generated" : "current"}`,
      plural(objectTypes, "object type"),
      relativePath(path)
    )
  )
}

export function dbMigrateView({
  projectId,
  status,
  applied = [],
}: {
  projectId: string
  status: "migrated" | "current" | "skipped"
  /** Migration step ids this run applied, named so the output can be checked. */
  applied?: readonly string[]
}): string {
  return screen(
    stack(
      headline("ok", "Database migrations complete", `${projectId} · storage ${status}`),
      ...applied.map((step) => `  ${tone.faint(glyph.rule)} ${tone.muted(step)}`)
    )
  )
}

export function lakeCheckView({
  projectId,
  warnings = [],
}: {
  projectId: string
  warnings?: readonly string[]
}): string {
  return screen(headline("ok", "Lake definitions compatible", projectId), warningLines(warnings))
}

export interface LakeCleanupReport {
  readonly dryRun: boolean
  readonly expireOlderThan: string
  readonly deleteOlderThan: string
  readonly snapshots: number
  readonly keptSnapshots?: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

export function lakeCleanupView({
  projectId,
  report,
}: {
  projectId: string
  report: LakeCleanupReport
}): string {
  return screen(
    header(report.dryRun ? "lake cleanup --dry-run" : "lake cleanup", projectId),
    rows([
      { label: "Expire older than", value: report.expireOlderThan },
      { label: "Delete older than", value: report.deleteOlderThan },
      { label: "Snapshots", value: String(report.snapshots) },
      ...(report.keptSnapshots === undefined
        ? []
        : [{ label: "Kept snapshots", value: String(report.keptSnapshots) }]),
      { label: "Old files", value: String(report.oldFiles) },
      { label: "Orphaned files", value: String(report.orphanedFiles) },
    ]),
    headline(
      "ok",
      report.dryRun ? "Lake cleanup dry run complete" : "Lake cleanup complete",
      report.dryRun ? "nothing was deleted" : undefined
    )
  )
}

export function initView({
  name,
  files,
  commands: next,
}: {
  name: string
  files: readonly string[]
  commands: readonly string[]
}): string {
  return screen(
    headline("ok", "Sixb initialized", `${name} · ${plural(files.length, "file")}`),
    section("Next steps", commands(next))
  )
}

/** A path under the working directory reads shorter relative to it. */
function relativePath(path: string): string {
  const cwd = process.cwd()
  if (path === cwd) return "."
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}
