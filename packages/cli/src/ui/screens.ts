import { CLI_EXAMPLES, type CliHelp, ROOT_HELP, ROOT_HELP_GROUPS } from "../lib/command-line"
import {
  commands,
  contentWidth,
  header,
  headline,
  hints,
  marked,
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
  warnings as warningLines,
} from "./layout"
import { colorLevel, glyph, paint, palette, tone } from "./theme"

export type KeyValueItem = { label: string; value: string }

const DOCS_URL = "https://docs.sixb.ai"

// ─── Help ────────────────────────────────────────────────────────────────────

/** Help reads by name: the command or option stands out, what it does stays quiet. */
const HELP_ROWS = (labelWidth?: number) => ({
  ...(labelWidth === undefined ? {} : { labelWidth }),
  labelStyle: (text: string) => text,
  valueStyle: tone.muted,
})

export function versionView(version: string): string {
  return `${version}\n`
}

export function helpView({ errorMessage }: { errorMessage?: string } = {}): string {
  const labelWidth = Math.max(
    ...ROOT_HELP_GROUPS.flatMap((group) => group.items.map((item) => item.label.length))
  )
  return screen(
    stack(header("", ROOT_HELP.summary)),
    errorMessage ? headline("fail", errorMessage) : null,
    section("Usage", `${tone.faint("$")} ${ROOT_HELP.usage}`),
    ...ROOT_HELP_GROUPS.map((group) =>
      section(
        group.title,
        rows(
          group.items.map((item) => ({ label: item.label, value: item.value })),
          HELP_ROWS(labelWidth)
        )
      )
    ),
    section("Options", rows(ROOT_HELP.options, HELP_ROWS(labelWidth))),
    section("Examples", commands(CLI_EXAMPLES)),
    `${tone.strong("sixb <command> --help")} ${tone.muted("lists a command's options.")}  ${tone.muted("Docs")} ${tone.url(DOCS_URL)}`
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
    help.commands.length > 0 ? section("Commands", rows(help.commands, HELP_ROWS())) : null,
    help.options.length > 0 ? section("Options", rows(help.options, HELP_ROWS())) : null
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
      ...(titled ? wrapLines(shown, width).map((line) => `  ${line}`) : [])
    ),
    details.length > 0 ? quoted(details) : null,
    remediation ? rows([{ label: "Try this", value: remediation }]) : null
  )
}

function wrapLines(text: string, width: number): string[] {
  return paragraph(text, (line) => line, width).split("\n")
}

const TITLE_STATUS: Record<string, Status> = {
  green: "ok",
  yellow: "warn",
  red: "fail",
}

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
    stack(
      headline(TITLE_STATUS[titleColor] ?? "ok", title),
      subtitle ? `  ${tone.muted(subtitle)}` : null
    ),
    rows(items),
    message ? paragraph(message, tone.muted) : null
  )
}

export function tableResultView({
  title,
  subtitle,
  headers,
  rows: cells,
  emptyMessage,
}: {
  title: string
  subtitle?: string
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  emptyMessage: string
}): string {
  return screen(
    stack(tone.strong(title), subtitle ? tone.muted(subtitle) : null),
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
    stack(headline("ok", title), subtitle ? `  ${tone.muted(subtitle)}` : null),
    rows(items),
    stack(tone.muted(secretLabel), paint(secret, { color: palette.blue, bold: true })),
    message ? marked(tone.warn(glyph.warn), message, tone.warn) : null
  )
}

// ─── Roles ───────────────────────────────────────────────────────────────────

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
    stack(header(command, name), `${tone.blue(glyph.live)} ${tone.strong("running")}`),
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
    stack(header("dev", name), `${tone.blue(glyph.live)} ${tone.strong("ready")}`),
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
  const validation = projectValidation ?? { ok: true, message: "ok" }
  const ontologyOk = (ontology?.errors ?? 0) === 0
  const markingsCheck = markings ?? { ok: true, message: "ok" }
  const healthy =
    [storage, timeseries, broker, queues, validation, markingsCheck].every((row) => row.ok) &&
    ontologyOk

  // The message wins when there is one, pass or fail: a probe that succeeded still says which
  // provider answered and whether its schema is current. The mark already says it passed.
  const probe = (label: string, row: Probe): Row => ({
    label,
    status: !row.ok ? "fail" : row.warning ? "warn" : "ok",
    value: (row.message ?? (row.ok ? "ok" : "failed")).replace(/^ok · /, ""),
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
              notes: [relativePath(ontology.source)],
            },
          ]
        : []),
    ]),
    warningLines(warnings),
    healthy
      ? headline("ok", "Sixb is healthy", problems > 0 ? plural(problems, "warning") : undefined)
      : headline("fail", "Sixb has issues")
  )
}

export function buildView({
  entry,
  outdir,
  seconds,
}: {
  entry: string
  outdir: string
  seconds?: number
}): string {
  return screen(
    header("build"),
    rows([
      { label: "entry", value: relativePath(entry) },
      { label: "output", value: relativePath(outdir) },
    ]),
    headline("ok", "Built", seconds === undefined ? undefined : `${seconds.toFixed(1)}s`)
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
    header("typegen"),
    rows([
      { label: "output", value: relativePath(path) },
      { label: "object types", value: String(objectTypes) },
    ]),
    headline(
      skipped ? "idle" : "ok",
      `Ontology types ${skipped ? "skipped" : written ? "generated" : "current"}`
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
    header("db migrate", projectId),
    rows([{ label: "Storage", value: status }]),
    applied.length > 0
      ? section("Applied", applied.map((step) => `${tone.ok(glyph.ok)} ${step}`).join("\n"))
      : null,
    headline("ok", "Database migrations complete")
  )
}

export function lakeCheckView({
  projectId,
  status,
  warnings = [],
}: {
  projectId: string
  status: "ok"
  warnings?: readonly string[]
}): string {
  return screen(
    header("lake check", projectId),
    rows([{ label: "Lake", value: status, status: "ok" }]),
    warningLines(warnings),
    headline("ok", "Lake definitions compatible")
  )
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
  targetDir,
  files,
  commands: next,
}: {
  name: string
  targetDir: string
  files: readonly string[]
  commands: readonly string[]
}): string {
  return screen(
    stack(headline("ok", "Sixb initialized"), `  ${tone.muted(`${name} · ${targetDir}`)}`),
    section("Files", fileTree(files)),
    section("Next steps", commands(next))
  )
}

/** Files grouped by folder, the way a project reads. */
function fileTree(files: readonly string[]): string {
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const slash = file.indexOf("/")
    const folder = slash === -1 ? "" : file.slice(0, slash + 1)
    groups.set(folder, [...(groups.get(folder) ?? []), slash === -1 ? file : file.slice(slash + 1)])
  }
  const root = groups.get("") ?? []
  groups.delete("")
  const width = Math.max(0, ...[...groups.keys()].map((folder) => folder.length)) + 2
  const room = Math.max(20, contentWidth() - width)
  const hanging = " ".repeat(width)
  return [
    ...[...groups].map(([folder, names]) =>
      packed(names, room)
        .map((line, index) =>
          index === 0
            ? `${tone.strong(folder.padEnd(width))}${tone.muted(line)}`
            : `${hanging}${tone.muted(line)}`
        )
        .join("\n")
    ),
    ...packed(root, contentWidth()).map((line) => tone.muted(line)),
  ].join("\n")
}

/** Names two spaces apart, as many to a line as fit. */
function packed(names: readonly string[], width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const name of names) {
    if (line && line.length + 2 + name.length > width) {
      lines.push(line)
      line = name
    } else {
      line = line ? `${line}  ${name}` : name
    }
  }
  if (line) lines.push(line)
  return lines
}

/** A path under the working directory reads shorter relative to it. */
export function relativePath(path: string): string {
  const cwd = process.cwd()
  if (path === cwd) return "."
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}
