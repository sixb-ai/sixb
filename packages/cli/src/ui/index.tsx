import { Box, render, Text } from "ink"
import type React from "react"
import { useEffect, useMemo, useState } from "react"

// ─── Primitives ──────────────────────────────────────────────────────────────

export async function renderStatic(view: React.ReactNode) {
  const app = render(<Box flexDirection="column">{view}</Box>, { exitOnCtrlC: false })
  // Let ink paint, then tear down explicitly. useApp().exit() + waitUntilExit()
  // stopped resolving in ink v6, which caused callers (e.g. `pario worker`) to
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
        pario
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
      <Text> pario {"<command>"} [options]</Text>
      <Spacer />
      <SectionTitle>Commands</SectionTitle>
      <KeyValueList
        labelWidth={22}
        items={[
          { label: "dev", value: "Start local development (server + built-in UI + app)" },
          { label: "worker", value: "Start the dedicated worker runtime" },
          { label: "check", value: "Validate project configuration and health" },
          { label: "build", value: "Build for production" },
          { label: "start", value: "Start production server" },
          { label: "db migrate", value: "Run adapter-owned database migrations" },
          { label: "init [dir]", value: "Initialize pario project in directory" },
          { label: "create <name>", value: "Create a new pario project" },
        ]}
      />
      <Spacer />
      <SectionTitle>Options</SectionTitle>
      <KeyValueList
        labelWidth={22}
        items={[
          { label: "--entry <path>", value: "Entry file (default: pario.config.ts)" },
          { label: "--port <port>", value: "Atlas UI port (default: 3000)" },
          { label: "--host <host>", value: "Browser app bind host (default: 0.0.0.0)" },
          { label: "--api-port <port>", value: "API port (default: Atlas port + 2)" },
          { label: "--api-host <host>", value: "API bind host (default: --host)" },
          { label: "--api-public-origin <origin>", value: "Public API origin" },
          { label: "--atlas-public-origin <origin>", value: "Public Atlas origin" },
          { label: "--sentinel-public-origin <origin>", value: "Public Sentinel origin" },
          { label: "--app-public-origin <origin>", value: "Public custom app origin" },
          {
            label: "--worker <type>",
            value: "Worker type: sync, action, pipeline, projection, workflow",
          },
          { label: "--outdir <path>", value: "Build output directory" },
          { label: "--help", value: "Show this help message" },
          { label: "--version", value: "Show version" },
        ]}
      />
      <Spacer />
      <SectionTitle>Examples</SectionTitle>
      <BulletList
        dim
        items={[
          "pario dev",
          "pario worker",
          "pario worker --worker pipeline",
          "pario worker --worker workflow",
          "pario dev --entry examples/mac-os/pario.config.ts --port 8080",
          "pario check",
          "pario db migrate",
          "pario build",
          "pario create my-project",
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
  sentinelUrl,
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
  sentinelUrl: string | null
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
  if (sentinelUrl) {
    serverItems.push({ label: "Sentinel UI", value: sentinelUrl })
  }

  return (
    <Box flexDirection="column">
      <Text bold>pario dev</Text>
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
  sentinelUrl,
  appUrl,
  warnings = [],
}: {
  name: string
  apiUrl: string
  apiDocsUrl: string
  wsUrl: string
  uiUrl: string | null
  uiStatus?: string | null
  sentinelUrl: string | null
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
  if (sentinelUrl) {
    serverItems.push({ label: "Sentinel UI", value: sentinelUrl })
  }

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Pario started
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
        Pario worker started
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
        {allOk ? "Pario is healthy" : "Pario has issues"}
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
        Pario created
      </Text>
      <Text dimColor>{name}</Text>
      <Text dimColor>{targetDir}</Text>
      <Spacer />
      <SectionTitle>Files</SectionTitle>
      <BulletList items={files} />
      <Spacer />
      <SectionTitle>Next steps</SectionTitle>
      <BulletList dim items={[`cd ${name}`, "bun install", "pario dev"]} />
    </Box>
  )
}
