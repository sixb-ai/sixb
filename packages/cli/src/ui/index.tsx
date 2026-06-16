import { Box, render, Text } from "ink"
import type React from "react"
import { useEffect, useMemo, useState } from "react"

// ─── Primitives ──────────────────────────────────────────────────────────────

export async function renderStatic(view: React.ReactNode) {
  const app = render(<Box flexDirection="column">{view}</Box>, { exitOnCtrlC: false })
  // Let ink paint, then tear down explicitly. useApp().exit() + waitUntilExit()
  // stopped resolving in ink v6, which caused callers (e.g. `sixb worker`) to
  // hang and never reach their `process.exit(1)`, masking failures with exit 0.
  await new Promise<void>((resolve) => setImmediate(resolve))
  app.unmount()
}

export function renderPersistent(view: React.ReactNode) {
  return render(view, { exitOnCtrlC: false })
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text color="cyan" bold>
      {children}
    </Text>
  )
}

function Spacer() {
  return <Text> </Text>
}

function padLabel(label: string, width: number) {
  if (label.length >= width) return `${label} `
  return label.padEnd(width, " ")
}

type KeyValueItem = { label: string; value: string }

function isUrl(value: string): boolean {
  return /^(https?|wss?):\/\//.test(value)
}

function KeyValueList({ items, labelWidth }: { items: KeyValueItem[]; labelWidth?: number }) {
  const resolvedWidth = Math.max(labelWidth ?? 0, ...items.map((item) => item.label.length))

  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Text key={`${item.label}:${item.value}`}>
          <Text dimColor>{padLabel(item.label, resolvedWidth + 2)}</Text>
          <Text color={isUrl(item.value) ? "cyan" : undefined}>{item.value}</Text>
        </Text>
      ))}
    </Box>
  )
}

function Panel({
  title,
  meta,
  borderColor = "gray",
  children,
}: {
  title: string
  meta?: React.ReactNode
  borderColor?: string
  children: React.ReactNode
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        {meta ? <Box>{meta}</Box> : null}
      </Box>
      <Spacer />
      {children}
    </Box>
  )
}

function ServicePanel({ name, items }: { name: string; items: KeyValueItem[] }) {
  return (
    <Box flexDirection="column">
      <Text bold>{name}</Text>
      <KeyValueList items={items} labelWidth={10} />
    </Box>
  )
}

function BulletList({ items, dim = false }: { items: readonly string[]; dim?: boolean }) {
  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Text key={`${index}:${item}`} dimColor={dim}>
          - {item}
        </Text>
      ))}
    </Box>
  )
}

function Spinner({ label }: { label: string }) {
  const frames = useMemo(() => ["|", "/", "-", "\\"], [])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % frames.length)
    }, 80)

    return () => clearInterval(timer)
  }, [frames.length])

  return (
    <Text>
      <Text color="cyan">{frames[index]}</Text> {label}
    </Text>
  )
}

// ─── Views ───────────────────────────────────────────────────────────────────

export function LoadingView({
  title,
  subtitle,
  status,
}: {
  title: string
  subtitle?: string
  status: string
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Spacer />
      <Text dimColor>Booting services</Text>
      <Spinner label={status} />
    </Box>
  )
}

export function HelpView({ errorMessage }: { errorMessage?: string }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        sixb
      </Text>
      <Text dimColor>Real-time digital twin framework</Text>
      {errorMessage ? (
        <>
          <Spacer />
          <Text color="red">{errorMessage}</Text>
        </>
      ) : null}
      <Spacer />
      <SectionTitle>Usage</SectionTitle>
      <Text> sixb {"<command>"} [options]</Text>
      <Spacer />
      <SectionTitle>Commands</SectionTitle>
      <KeyValueList
        labelWidth={22}
        items={[
          { label: "dev", value: "Start local development (server + built-in UI + app)" },
          { label: "api", value: "Start production API/docs/WebSocket server" },
          { label: "atlas", value: "Start production Atlas UI server" },
          { label: "app", value: "Start production custom app server" },
          { label: "scheduler", value: "Start production scheduler event producer" },
          { label: "orchestrator", value: "Start production event-to-queue dispatcher" },
          { label: "functions", value: "Start production functions runtime" },
          { label: "rules", value: "Start production rules runtime" },
          {
            label: "worker <type>",
            value: "Start production queue worker: sync, action, pipeline, projection, workflow",
          },
          {
            label: "worker-group [types...]",
            value: "Co-host multiple queue workers in one process (constrained resources)",
          },
          { label: "check", value: "Validate project configuration and health" },
          { label: "build", value: "Build runtime and production UI/app assets" },
          { label: "db migrate", value: "Run adapter-owned database migrations" },
          { label: "lake check", value: "Check lake dataset definitions for drift" },
          { label: "lake cleanup", value: "Run lake storage maintenance cleanup" },
          { label: "init [dir]", value: "Initialize sixb project in directory" },
          { label: "create <name>", value: "Create a new sixb project" },
        ]}
      />
      <Spacer />
      <SectionTitle>Options</SectionTitle>
      <KeyValueList
        labelWidth={22}
        items={[
          { label: "--entry <path>", value: "Entry file (default: sixb.config.ts)" },
          { label: "--port <port>", value: "Role port; dev uses Atlas base port" },
          { label: "--host <host>", value: "Browser app bind host (default: 0.0.0.0)" },
          { label: "--api-port <port>", value: "API port (default: Atlas port + 2)" },
          { label: "--api-host <host>", value: "API bind host (default: --host)" },
          { label: "--api-public-origin <origin>", value: "Public API origin" },
          { label: "--atlas-public-origin <origin>", value: "Public Atlas origin" },
          { label: "--app-public-origin <origin>", value: "Public custom app origin" },
          { label: "--outdir <path>", value: "Build output directory" },
          { label: "--dry-run", value: "Preview lake cleanup without changing storage" },
          { label: "--expire-older-than <interval>", value: "Lake snapshot expiration window" },
          { label: "--delete-older-than <interval>", value: "Lake file deletion window" },
          { label: "--help", value: "Show this help message" },
          { label: "--version", value: "Show version" },
        ]}
      />
      <Spacer />
      <SectionTitle>Examples</SectionTitle>
      <BulletList
        dim
        items={[
          "sixb dev",
          "sixb build",
          "sixb api",
          "sixb atlas",
          "sixb app",
          "sixb scheduler",
          "sixb orchestrator",
          "sixb functions",
          "sixb rules",
          "sixb worker pipeline",
          "sixb worker workflow",
          "sixb worker-group sync pipeline projection",
          "sixb dev --entry examples/mac-os/sixb.config.ts --port 8080",
          "sixb check",
          "sixb db migrate",
          "sixb lake check",
          "sixb lake cleanup --dry-run",
          "sixb create my-project",
        ]}
      />
    </Box>
  )
}

export function VersionView({ version }: { version: string }) {
  return <Text>{version}</Text>
}

export function ErrorView({
  title = "Error",
  message,
  details = [],
}: {
  title?: string
  message: string
  details?: string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="red" bold>
        {title}
      </Text>
      <Spacer />
      <Panel title="Failure" borderColor="red">
        <Text>{message}</Text>
      </Panel>
      {details.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Details</SectionTitle>
          <BulletList items={details} />
        </>
      ) : null}
    </Box>
  )
}

export function DevView({
  name,
  apiUrl,
  apiDocsUrl,
  wsUrl,
  uiUrl,
  uiStatus,
  appUrl,
  mqttUrl,
  warnings = [],
}: {
  name: string
  apiUrl: string
  apiDocsUrl: string
  wsUrl: string
  uiUrl: string | null
  uiStatus: string | null
  appUrl?: string | null
  mqttUrl: string | null
  warnings?: readonly string[]
}) {
  const serverItems: KeyValueItem[] = [
    { label: "API", value: apiUrl },
    { label: "API docs", value: apiDocsUrl },
    { label: "Events", value: wsUrl },
  ]
  if (uiUrl) {
    serverItems.push({ label: "Atlas UI", value: uiUrl })
  } else if (uiStatus) {
    serverItems.push({ label: "Atlas UI", value: uiStatus })
  }

  return (
    <Box flexDirection="column">
      <Text bold>sixb dev</Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel name="Server" items={serverItems} />
      {appUrl ? (
        <>
          <Spacer />
          <ServicePanel name="Custom app" items={[{ label: "URL", value: appUrl }]} />
        </>
      ) : null}
      {mqttUrl ? (
        <>
          <Spacer />
          <ServicePanel name="MQTT" items={[{ label: "Broker", value: mqttUrl }]} />
        </>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <Text color="yellow" bold>
            Warnings
          </Text>
          <BulletList items={warnings} />
        </>
      ) : null}
      <Spacer />
      <Text dimColor>ctrl+c to stop</Text>
    </Box>
  )
}

export function StartView({
  name,
  apiUrl,
  apiDocsUrl,
  wsUrl,
  uiUrl,
  uiStatus,
  appUrl,
  warnings = [],
}: {
  name: string
  apiUrl: string
  apiDocsUrl: string
  wsUrl: string
  uiUrl: string | null
  uiStatus?: string | null
  appUrl?: string | null
  warnings?: readonly string[]
}) {
  const serverItems: KeyValueItem[] = [
    { label: "API", value: apiUrl },
    { label: "API docs", value: apiDocsUrl },
    { label: "Events", value: wsUrl },
  ]
  if (uiUrl) {
    serverItems.push({ label: "Atlas UI", value: uiUrl })
  } else if (uiStatus) {
    serverItems.push({ label: "Atlas UI", value: uiStatus })
  }

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb started
      </Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel name="Server" items={serverItems} />
      {appUrl ? (
        <>
          <Spacer />
          <ServicePanel name="Custom app" items={[{ label: "URL", value: appUrl }]} />
        </>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Warnings</SectionTitle>
          <BulletList items={warnings} />
        </>
      ) : null}
      <Spacer />
      <Text dimColor>Press Ctrl+C to stop</Text>
    </Box>
  )
}

export function WorkerView({
  name,
  workerId,
  warnings = [],
}: {
  name: string
  workerId: string
  warnings?: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb worker started
      </Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel name="Worker" items={[{ label: "ID", value: workerId }]} />
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Warnings</SectionTitle>
          <BulletList items={warnings} />
        </>
      ) : null}
      <Spacer />
      <Text dimColor>Press Ctrl+C to stop</Text>
    </Box>
  )
}

export function WorkerGroupView({
  name,
  workerTypes,
  warnings = [],
}: {
  name: string
  workerTypes: readonly string[]
  warnings?: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb worker group started
      </Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel
        name="Workers"
        items={workerTypes.map((workerType) => ({ label: workerType, value: "running" }))}
      />
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Warnings</SectionTitle>
          <BulletList items={warnings} />
        </>
      ) : null}
      <Spacer />
      <Text dimColor>Press Ctrl+C to stop</Text>
    </Box>
  )
}

export function RoleView({
  title,
  name,
  serviceName,
  items,
  warnings = [],
}: {
  title: string
  name: string
  serviceName: string
  items: KeyValueItem[]
  warnings?: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {title}
      </Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel name={serviceName} items={items} />
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Warnings</SectionTitle>
          <BulletList items={warnings} />
        </>
      ) : null}
      <Spacer />
      <Text dimColor>Press Ctrl+C to stop</Text>
    </Box>
  )
}

export function CheckView({
  projectId,
  events,
  storage,
  timeseries,
  broker,
  projectValidation,
  ontology,
  warnings,
}: {
  projectId: string
  events: { ok: boolean; message?: string }
  storage: { ok: boolean; message?: string }
  timeseries: { ok: boolean; message?: string }
  broker: { ok: boolean; message?: string }
  projectValidation?: { ok: boolean; message?: string }
  ontology?: { enabled: boolean; source: string; errors: number; warnings: number }
  warnings: string[]
}) {
  const validation = projectValidation ?? { ok: true, message: "ok" }
  const ontologyOk = (ontology?.errors ?? 0) === 0
  const allOk = events.ok && storage.ok && timeseries.ok && broker.ok && validation.ok && ontologyOk

  function statusText(provider: { ok: boolean; message?: string }): string {
    if (provider.ok) return "ok"
    return provider.message ?? "failed"
  }

  function statusColor(ok: boolean): string {
    return ok ? "green" : "red"
  }

  return (
    <Box flexDirection="column">
      <Text color={allOk ? "green" : "red"} bold>
        {allOk ? "Sixb is healthy" : "Sixb has issues"}
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <SectionTitle>Providers</SectionTitle>
      <Box flexDirection="column">
        <Text>
          <Text dimColor>{padLabel("Events", 14)}</Text>
          <Text color={statusColor(events.ok)}>{statusText(events)}</Text>
        </Text>
        <Text>
          <Text dimColor>{padLabel("Storage", 14)}</Text>
          <Text color={statusColor(storage.ok)}>{statusText(storage)}</Text>
        </Text>
        <Text>
          <Text dimColor>{padLabel("Timeseries", 14)}</Text>
          <Text color={statusColor(timeseries.ok)}>{statusText(timeseries)}</Text>
        </Text>
        <Text>
          <Text dimColor>{padLabel("Broker", 14)}</Text>
          <Text color={statusColor(broker.ok)}>{statusText(broker)}</Text>
        </Text>
        <Text>
          <Text dimColor>{padLabel("Project", 14)}</Text>
          <Text color={statusColor(validation.ok)}>{statusText(validation)}</Text>
        </Text>
      </Box>
      {ontology ? (
        <>
          <Spacer />
          <SectionTitle>Ontology</SectionTitle>
          <KeyValueList
            items={[
              { label: "Source", value: ontology.source },
              { label: "Errors", value: String(ontology.errors) },
              { label: "Warnings", value: String(ontology.warnings) },
            ]}
          />
        </>
      ) : null}
      {warnings.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Warnings</SectionTitle>
          <BulletList items={warnings} />
        </>
      ) : null}
    </Box>
  )
}

export function BuildView({ entry, outdir }: { entry: string; outdir: string }) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Built
      </Text>
      <Spacer />
      <KeyValueList
        items={[
          { label: "Entry", value: entry },
          { label: "Output", value: outdir },
        ]}
      />
    </Box>
  )
}

export function DbMigrateView({
  projectId,
  status,
}: {
  projectId: string
  status: "migrated" | "current" | "skipped"
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Database migrations complete
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <KeyValueList items={[{ label: "Storage", value: status }]} />
    </Box>
  )
}

export function LakeCheckView({ projectId, status }: { projectId: string; status: "ok" }) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Lake definitions compatible
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <KeyValueList items={[{ label: "Lake", value: status }]} />
    </Box>
  )
}

export interface LakeCleanupReport {
  readonly dryRun: boolean
  readonly expireOlderThan: string
  readonly deleteOlderThan: string
  readonly snapshots: number
  readonly oldFiles: number
  readonly orphanedFiles: number
}

export function LakeCleanupView({
  projectId,
  report,
}: {
  projectId: string
  report: LakeCleanupReport
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {report.dryRun ? "Lake cleanup dry run complete" : "Lake cleanup complete"}
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <KeyValueList
        items={[
          { label: "Dry run", value: String(report.dryRun) },
          { label: "Expire older than", value: report.expireOlderThan },
          { label: "Delete older than", value: report.deleteOlderThan },
          { label: "Snapshots", value: String(report.snapshots) },
          { label: "Old files", value: String(report.oldFiles) },
          { label: "Orphaned files", value: String(report.orphanedFiles) },
        ]}
      />
    </Box>
  )
}

export function InitView({
  name,
  targetDir,
  files,
}: {
  name: string
  targetDir: string
  files: string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb created
      </Text>
      <Text dimColor>{name}</Text>
      <Text dimColor>{targetDir}</Text>
      <Spacer />
      <SectionTitle>Files</SectionTitle>
      <BulletList items={files} />
      <Spacer />
      <SectionTitle>Next steps</SectionTitle>
      <BulletList dim items={[`cd ${name}`, "bun install", "sixb dev"]} />
    </Box>
  )
}
