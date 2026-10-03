import type {
  DeployAccessKey,
  DeployCheck,
  DeployCommand,
  DeployRelease,
  DeployStatus,
} from "@sixb/core/deploy"
import { Box, render, Text } from "ink"
import type React from "react"
import { useEffect, useMemo, useState } from "react"
import { CLI_EXAMPLES, type CliHelp, ROOT_HELP } from "../lib/command-line"
import { errorMessage, errorRemediation } from "../lib/errors"

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

/**
 * Renders a caught failure the one way the CLI renders failures, so a remediation carried on
 * the error reaches the terminal without each caller remembering to pass it through.
 */
export async function renderCliError(
  error: unknown,
  options: { readonly title?: string; readonly details?: readonly string[] } = {}
): Promise<void> {
  await renderStatic(
    <ErrorView
      {...(options.title ? { title: options.title } : {})}
      message={errorMessage(error)}
      {...(errorRemediation(error) ? { remediation: errorRemediation(error) } : {})}
      {...(options.details ? { details: options.details } : {})}
    />
  )
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

export type KeyValueItem = { label: string; value: string }

function isUrl(value: string): boolean {
  return /^(https?|wss?):\/\//.test(value)
}

function KeyValueList({
  items,
  labelWidth,
}: {
  items: readonly KeyValueItem[]
  labelWidth?: number
}) {
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

function Table({
  headers,
  rows,
}: {
  headers: readonly string[]
  rows: readonly (readonly string[])[]
}) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
  )

  return (
    <Box flexDirection="column">
      <Text>
        {headers.map((header, index) => (
          <Text key={`${index}:${header}`} bold>
            {header.padEnd(widths[index] ?? header.length)}
            {index === headers.length - 1 ? "" : "  "}
          </Text>
        ))}
      </Text>
      <Text dimColor>{widths.map((width) => "-".repeat(width)).join("  ")}</Text>
      {rows.map((row, rowIndex) => (
        <Text key={`${rowIndex}:${row.join(":")}`}>
          {row.map((value, index) => (
            <Text key={`${index}:${value}`}>
              {value.padEnd(widths[index] ?? value.length)}
              {index === row.length - 1 ? "" : "  "}
            </Text>
          ))}
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

export function KeyValueResultView({
  title,
  subtitle,
  items,
  titleColor = "green",
  message,
}: {
  title: string
  subtitle?: string
  items: readonly KeyValueItem[]
  titleColor?: string
  message?: string
}) {
  return (
    <Box flexDirection="column">
      <Text color={titleColor} bold>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Spacer />
      <KeyValueList items={items} />
      {message ? (
        <>
          <Spacer />
          <Text dimColor>{message}</Text>
        </>
      ) : null}
    </Box>
  )
}

export function TableResultView({
  title,
  subtitle,
  headers,
  rows,
  emptyMessage,
}: {
  title: string
  subtitle?: string
  headers: readonly string[]
  rows: readonly (readonly string[])[]
  emptyMessage: string
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Spacer />
      {rows.length > 0 ? (
        <Table headers={headers} rows={rows} />
      ) : (
        <Text dimColor>{emptyMessage}</Text>
      )}
    </Box>
  )
}

export function SecretResultView({
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
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {title}
      </Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      <Spacer />
      <KeyValueList items={items} />
      <Spacer />
      <Panel title={secretLabel} borderColor="yellow">
        <Text>{secret}</Text>
      </Panel>
      {message ? (
        <>
          <Spacer />
          <Text dimColor>{message}</Text>
        </>
      ) : null}
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

/**
 * What the role did to the storage schema at startup, worded the same way by every
 * role. Absent when there was nothing to report, so a runtime without migrators does
 * not grow a panel that says nothing.
 */
function StoragePanel({ summary }: { summary?: string | null }) {
  if (!summary) return null

  return (
    <>
      <Spacer />
      <ServicePanel name="Storage" items={[{ label: "Schema", value: summary }]} />
    </>
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
      <Text> {ROOT_HELP.usage}</Text>
      <Spacer />
      <SectionTitle>Commands</SectionTitle>
      <KeyValueList labelWidth={22} items={ROOT_HELP.commands} />
      <Spacer />
      <SectionTitle>Options</SectionTitle>
      <KeyValueList labelWidth={22} items={ROOT_HELP.options} />
      <Spacer />
      <SectionTitle>Examples</SectionTitle>
      <BulletList dim items={CLI_EXAMPLES} />
    </Box>
  )
}

export function CommandHelpView({ help, errorMessage }: { help: CliHelp; errorMessage?: string }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        {help.path.length > 0 ? help.path.join(" ") : "sixb"}
      </Text>
      <Text dimColor>{help.summary}</Text>
      {errorMessage ? (
        <>
          <Spacer />
          <Text color="red">{errorMessage}</Text>
        </>
      ) : null}
      <Spacer />
      <SectionTitle>Usage</SectionTitle>
      <Text> {help.usage}</Text>
      {help.commands.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Commands</SectionTitle>
          <KeyValueList items={help.commands} />
        </>
      ) : null}
      {help.options.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Options</SectionTitle>
          <KeyValueList items={help.options} />
        </>
      ) : null}
    </Box>
  )
}

export function VersionView({ version }: { version: string }) {
  return <Text>{version}</Text>
}

export function ErrorView({
  title = "Error",
  message,
  remediation,
  details = [],
}: {
  title?: string
  message: string
  /** What to do next. Rendered apart from the diagnosis, not appended to it. */
  remediation?: string
  details?: readonly string[]
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
      {remediation ? (
        <>
          <Spacer />
          <SectionTitle>Try this</SectionTitle>
          <Text>{remediation}</Text>
        </>
      ) : null}
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
  appUrl,
  workers = [],
  warnings = [],
}: {
  name: string
  apiUrl: string
  apiDocsUrl: string
  wsUrl: string
  uiUrl: string | null
  appUrl?: string | null
  workers?: readonly { readonly type: string; readonly concurrency: number }[]
  warnings?: readonly string[]
}) {
  const serverItems: KeyValueItem[] = [
    { label: "API", value: apiUrl },
    { label: "API docs", value: apiDocsUrl },
    { label: "Events", value: wsUrl },
  ]
  if (uiUrl) {
    serverItems.push({ label: "Atlas UI", value: uiUrl })
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
      {workers.length > 0 ? (
        <>
          <Spacer />
          <ServicePanel
            name="Workers"
            items={workers.map((worker) => ({
              label: worker.type,
              value: `running · concurrency ${worker.concurrency}`,
            }))}
          />
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

export function WorkerView({
  name,
  workerId,
  concurrency,
  storage,
  warnings = [],
}: {
  name: string
  workerId: string
  concurrency: number
  storage?: string | null
  warnings?: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb worker started
      </Text>
      <Text dimColor>{name}</Text>
      <Spacer />
      <ServicePanel
        name="Worker"
        items={[
          { label: "ID", value: workerId },
          { label: "Concurrency", value: String(concurrency) },
        ]}
      />
      <StoragePanel summary={storage} />
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
  workers,
  storage,
  warnings = [],
}: {
  name: string
  workers: readonly { readonly type: string; readonly concurrency: number }[]
  storage?: string | null
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
        items={workers.map((worker) => ({
          label: worker.type,
          value: `running · concurrency ${worker.concurrency}`,
        }))}
      />
      <StoragePanel summary={storage} />
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
  storage,
  warnings = [],
}: {
  title: string
  name: string
  serviceName: string
  items: KeyValueItem[]
  storage?: string | null
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
      <StoragePanel summary={storage} />
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
  storage,
  timeseries,
  broker,
  queues,
  projectValidation,
  ontology,
  warnings,
}: {
  projectId: string
  storage: { ok: boolean; message?: string }
  timeseries: { ok: boolean; message?: string }
  broker: { ok: boolean; message?: string }
  queues: { ok: boolean; message?: string }
  projectValidation?: { ok: boolean; message?: string }
  ontology?: { enabled: boolean; source: string; errors: number; warnings: number }
  warnings: readonly string[]
}) {
  const validation = projectValidation ?? { ok: true, message: "ok" }
  const ontologyOk = (ontology?.errors ?? 0) === 0
  const allOk = [storage, timeseries, broker, queues, validation].every((row) => row.ok)
  const healthy = allOk && ontologyOk

  // The message wins when there is one, pass or fail: a probe that succeeded still says which
  // provider answered and whether its schema is current.
  function statusText(row: { ok: boolean; message?: string }): string {
    return row.message ?? (row.ok ? "ok" : "failed")
  }

  function statusColor(ok: boolean): string {
    return ok ? "green" : "red"
  }

  return (
    <Box flexDirection="column">
      <Text color={healthy ? "green" : "red"} bold>
        {healthy ? "Sixb is healthy" : "Sixb has issues"}
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <SectionTitle>Providers</SectionTitle>
      <Box flexDirection="column">
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
          <Text dimColor>{padLabel("Queues", 14)}</Text>
          <Text color={statusColor(queues.ok)}>{statusText(queues)}</Text>
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

export function TypegenView({
  path,
  objectTypes,
  skipped,
  written,
}: {
  path: string
  objectTypes: number
  skipped: boolean
  written: boolean
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Ontology types {skipped ? "skipped" : written ? "generated" : "current"}
      </Text>
      <Spacer />
      <KeyValueList
        items={[
          { label: "Output", value: path },
          { label: "Object types", value: String(objectTypes) },
        ]}
      />
    </Box>
  )
}

export function DbMigrateView({
  projectId,
  status,
  applied = [],
}: {
  projectId: string
  status: "migrated" | "current" | "skipped"
  /** Migration step ids this run applied, named so the output can be checked. */
  applied?: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Database migrations complete
      </Text>
      <Text dimColor>{projectId}</Text>
      <Spacer />
      <KeyValueList items={[{ label: "Storage", value: status }]} />
      {applied.length > 0 ? (
        <>
          <Spacer />
          <SectionTitle>Applied</SectionTitle>
          <BulletList items={applied} />
        </>
      ) : null}
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

export function DeployReleaseView({
  release,
  configPath,
}: {
  release: DeployRelease
  configPath: string
}) {
  const steps = [
    { label: "build", commands: release.steps.build },
    { label: "before start", commands: release.steps.beforeStart },
  ]
  const labelWidth =
    Math.max(
      ...release.services.map((service) => service.name.length),
      ...steps.map((step) => step.label.length)
    ) + 2
  const originWidth = Math.max(
    0,
    ...release.services.map((service) => service.http?.publicOrigin.length ?? 0)
  )
  const origins = new Set(
    release.services.flatMap((service) => (service.http ? [service.http.publicOrigin] : []))
  )
  // The public origins already show beside their services; list only what the config set.
  const env = Object.entries(release.env).filter(
    ([key, value]) => !(key.endsWith("_PUBLIC_ORIGIN") && origins.has(value))
  )

  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {release.name} · dry run
      </Text>
      <Text dimColor>
        {release.target.kind} {release.target.location} · {configPath}
      </Text>
      <Spacer />
      <SectionTitle>Services</SectionTitle>
      {release.services.map((service) => (
        <Box key={service.name}>
          <Box width={labelWidth} flexShrink={0}>
            <Text bold>{service.name}</Text>
          </Box>
          <Box flexDirection="column">
            {service.http ? (
              <Text>
                <Text color="cyan">{padLabel(service.http.publicOrigin, originWidth + 2)}</Text>
                <Text dimColor>
                  → {service.http.host}:{service.http.port}
                </Text>
              </Text>
            ) : (
              <Text dimColor>{describeDeployProcess(service)}</Text>
            )}
            <Text dimColor>{formatDeployCommand(service.command)}</Text>
            {Object.entries(service.env)
              .filter(([key, value]) => release.env[key] !== value)
              .map(([key, value]) => (
                <Text key={key} dimColor>
                  {key}={value}
                </Text>
              ))}
          </Box>
        </Box>
      ))}
      <Spacer />
      <SectionTitle>Steps</SectionTitle>
      {steps.map((step) => (
        <Box key={step.label}>
          <Box width={labelWidth} flexShrink={0}>
            <Text bold>{step.label}</Text>
          </Box>
          <Text>{step.commands.map(formatDeployCommand).join(" → ")}</Text>
        </Box>
      ))}
      <Spacer />
      <SectionTitle>Environment</SectionTitle>
      {env.map(([key, value]) => (
        <Text key={key}>
          {key}={value}
        </Text>
      ))}
      {origins.size > 0 ? <Text dimColor>plus the public origins above</Text> : null}
      <Spacer />
      <Text dimColor>Nothing was deployed · --json prints the full release</Text>
    </Box>
  )
}

export interface DeployProgressState {
  readonly name: string
  readonly location: string
  readonly commit: string
  readonly ref: string
  readonly dirty: boolean
  readonly labels: readonly string[]
  /** How many steps have finished, in order. */
  readonly done: number
  readonly current: number | null
  /** The latest output lines, shown while a step runs and kept when one fails. */
  readonly output: readonly string[]
  readonly outcome: "running" | "done" | "failed"
}

export function DeployProgressView({ state }: { state: DeployProgressState }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {state.name} → {state.location}
      </Text>
      <Text dimColor>
        {state.commit.slice(0, 12)} · {state.ref}
      </Text>
      {state.dirty ? <Text color="yellow">Uncommitted changes are not deployed.</Text> : null}
      <Spacer />
      {state.labels.length === 0 ? (
        <Spinner label="Connecting…" />
      ) : (
        state.labels.map((label, index) => {
          if (index < state.done) {
            return (
              <Text key={`${index}:${label}`}>
                <Text color="green">✓</Text> {label}
              </Text>
            )
          }
          if (index === state.current && state.outcome === "failed") {
            return (
              <Text key={`${index}:${label}`} color="red">
                ✕ {label}
              </Text>
            )
          }
          if (index === state.current && state.outcome === "running") {
            return <Spinner key={`${index}:${label}`} label={label} />
          }
          return (
            <Text key={`${index}:${label}`} dimColor>
              · {label}
            </Text>
          )
        })
      )}
      {state.outcome === "running" && state.output.length > 0 ? (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {state.output.slice(-6).map((line, index) => (
            <Text key={`${index}:${line}`} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

export function DeployCompleteView({
  release,
  commit,
  ref,
}: {
  release: DeployRelease
  commit: string
  ref: string
}) {
  const urls = release.services.flatMap((service) =>
    service.http ? [{ label: service.name, value: service.http.publicOrigin }] : []
  )
  return (
    <Box flexDirection="column">
      <Spacer />
      <Text color="green" bold>
        {release.name} deployed
      </Text>
      <Text dimColor>
        {commit.slice(0, 12)} · {ref} · {release.target.kind} {release.target.location}
      </Text>
      {urls.length > 0 ? (
        <>
          <Spacer />
          <KeyValueList items={urls} />
        </>
      ) : null}
    </Box>
  )
}

export function DeployStatusView({
  name,
  location,
  status,
}: {
  name: string
  location: string
  status: DeployStatus
}) {
  if (!status.release) {
    return (
      <Box flexDirection="column">
        <Text bold>{name}</Text>
        <Text dimColor>Nothing is deployed on {location} yet. Run `sixb deploy`.</Text>
      </Box>
    )
  }
  const healthy =
    status.running && status.processes.every((process) => process.status === "running")
  return (
    <Box flexDirection="column">
      <Text color={healthy ? "green" : "yellow"} bold>
        {name} {healthy ? "is running" : status.running ? "needs attention" : "is stopped"}
      </Text>
      <Text dimColor>
        {status.release.commit.slice(0, 12)} · {status.release.ref} · deployed{" "}
        {formatAge(status.release.deployedAt)} by {status.release.deployedBy} · {location}
      </Text>
      <Spacer />
      {status.processes.length > 0 ? (
        <Table
          headers={["Service", "Status", "PID", "CPU", "Memory", "Restarts", "Up"]}
          rows={status.processes.map((process) => [
            process.instance === 0 ? process.service : `${process.service}#${process.instance}`,
            process.status,
            process.pid === undefined ? "-" : String(process.pid),
            process.cpuPercent === undefined ? "-" : `${process.cpuPercent.toFixed(1)}%`,
            process.memoryBytes === undefined ? "-" : formatBytes(process.memoryBytes),
            String(process.restarts),
            process.status === "running" && process.startedAt
              ? formatAge(process.startedAt, "")
              : "-",
          ])}
        />
      ) : (
        <Text dimColor>The supervisor is not running.</Text>
      )}
      {status.processes
        .filter((process) => process.lastError)
        .map((process) => (
          <Text key={`${process.service}#${process.instance}`} color="yellow">
            {process.service}: {process.lastError}
          </Text>
        ))}
    </Box>
  )
}

const CHECK_MARKS = {
  ok: { glyph: "✓", color: "green" },
  fixable: { glyph: "●", color: "yellow" },
  manual: { glyph: "○", color: "yellow" },
  warning: { glyph: "!", color: "yellow" },
} as const satisfies Record<DeployCheck["status"], { glyph: string; color: string }>

export function DeployChecksView({
  name,
  location,
  checks,
}: {
  name: string
  location: string
  checks: readonly DeployCheck[]
}) {
  const blocking = checks.filter((check) => check.status === "fixable" || check.status === "manual")
  const warnings = checks.filter((check) => check.status === "warning")
  const labelWidth = Math.max(...checks.map((check) => check.label.length)) + 2
  const next = blocking.some((check) => check.status === "fixable")
    ? "Next: sixb deploy setup"
    : blocking.length > 0
      ? "Next: the steps above, then sixb deploy check"
      : "Next: sixb deploy"

  return (
    <Box flexDirection="column">
      <Text color={blocking.length > 0 ? "yellow" : "green"} bold>
        {name}{" "}
        {blocking.length > 0
          ? `· ${blocking.length} to fix before deploying`
          : `is ready to deploy${warnings.length > 0 ? ` · ${warnings.length} to look at` : ""}`}
      </Text>
      <Text dimColor>{location}</Text>
      <Spacer />
      {checks.map((check) => (
        <Box key={check.id}>
          <Box width={2} flexShrink={0}>
            <Text color={CHECK_MARKS[check.status].color}>{CHECK_MARKS[check.status].glyph}</Text>
          </Box>
          <Box width={labelWidth} flexShrink={0}>
            <Text>{check.label}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>{check.detail}</Text>
            {check.remedy ? <Text color="cyan">{check.remedy}</Text> : null}
          </Box>
        </Box>
      ))}
      <Spacer />
      <Text dimColor>{next}</Text>
    </Box>
  )
}

export function DeployCiView({
  name,
  repo,
  environment,
  branch,
  credential,
  secrets,
  retired,
  workflow,
  token,
}: {
  name: string
  repo: string
  environment: string
  branch: string
  credential: string
  secrets: readonly string[]
  retired: readonly DeployAccessKey[]
  workflow: { readonly path: string; readonly state: "written" | "unchanged" | "kept" }
  token: {
    readonly name: string
    readonly submodules: readonly {
      readonly path: string
      readonly url: string
      readonly repo: string | null
    }[]
  } | null
}) {
  const rows: { label: string; ok: boolean; detail: string; remedy?: string }[] = [
    { label: "Key", ok: true, detail: credential },
    { label: "Secrets", ok: true, detail: secrets.join(", ") },
    {
      label: "Older keys",
      ok: true,
      detail:
        retired.length === 0
          ? "none to revoke"
          : `revoked ${retired.map((key) => key.fingerprint).join(", ")}`,
    },
    {
      label: "Workflow",
      ok: true,
      detail: {
        written: workflow.path,
        unchanged: `${workflow.path} (unchanged)`,
        kept: `${workflow.path} (yours, kept: it differs from what this command writes; delete it and run again to start over)`,
      }[workflow.state],
    },
    ...(token
      ? [
          {
            label: "Token",
            ok: false,
            detail: `${token.submodules.map((submodule) => submodule.path).join(", ")} ${token.submodules.length === 1 ? "is" : "are"} private, and CI cannot read ${token.submodules.length === 1 ? "it" : "them"} with its own token.`,
            remedy: `Create a fine-grained token with Contents: read on ${token.submodules.map((submodule) => submodule.repo ?? submodule.url).join(", ")}, then run \`gh secret set ${token.name} --env ${environment} --repo ${repo}\`.`,
          },
        ]
      : []),
  ]
  const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 2
  const next =
    workflow.state === "written"
      ? `Next: commit ${workflow.path} and push to ${branch}.`
      : `Next: push to ${branch} to deploy.`

  return (
    <Box flexDirection="column">
      <Text color={token ? "yellow" : "green"} bold>
        {name} deploys from GitHub Actions on every push to {branch}
      </Text>
      <Text dimColor>
        {repo} · environment {environment}
      </Text>
      <Spacer />
      {rows.map((row) => (
        <Box key={row.label}>
          <Box width={2} flexShrink={0}>
            <Text color={row.ok ? "green" : "yellow"}>{row.ok ? "✓" : "○"}</Text>
          </Box>
          <Box width={labelWidth} flexShrink={0}>
            <Text>{row.label}</Text>
          </Box>
          <Box flexDirection="column">
            <Text dimColor>{row.detail}</Text>
            {row.remedy ? <Text color="cyan">{row.remedy}</Text> : null}
          </Box>
        </Box>
      ))}
      <Spacer />
      <Text dimColor>{next}</Text>
    </Box>
  )
}

export function DeployAccessView({
  title,
  keys,
}: {
  title: string
  keys: readonly DeployAccessKey[]
}) {
  // Two lines a key: a fingerprint and a long comment do not fit side by side in 80 columns.
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        {title}
      </Text>
      <Spacer />
      {keys.length === 0 ? <Text dimColor>No keys.</Text> : null}
      {keys.map((key) => (
        <Box key={key.fingerprint} flexDirection="column">
          <Text>
            {key.comment || "(no comment)"}
            {key.restricted ? <Text color="yellow"> restricted</Text> : null}
          </Text>
          <Text dimColor>
            {"  "}
            {key.type} {key.fingerprint}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function formatAge(iso: string, suffix = " ago"): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  const age =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m`
        : seconds < 86_400
          ? `${Math.floor(seconds / 3600)}h`
          : `${Math.floor(seconds / 86_400)}d`
  return `${age}${suffix}`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`
  return `${Math.round(bytes / 1024)}K`
}

function describeDeployProcess(service: DeployRelease["services"][number]): string {
  const count = `${service.instances} ${service.instances === 1 ? "process" : "processes"}`
  if (service.kind === "script") return `project script · ${count}`
  // `worker-group` without worker types runs every type the project registers work for.
  const namesWorkerTypes = service.command.args[1] && !service.command.args[1].startsWith("-")
  if (service.kind === "workers" && !namesWorkerTypes) {
    return `${count} · every worker type the project registers`
  }
  return count
}

function formatDeployCommand(command: DeployCommand): string {
  return [command.program, ...command.args].join(" ")
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
  commands,
}: {
  name: string
  targetDir: string
  files: string[]
  commands: readonly string[]
}) {
  return (
    <Box flexDirection="column">
      <Text color="green" bold>
        Sixb initialized
      </Text>
      <Text dimColor>{name}</Text>
      <Text dimColor>{targetDir}</Text>
      <Spacer />
      <SectionTitle>Files</SectionTitle>
      <BulletList items={files} />
      <Spacer />
      <SectionTitle>Next steps</SectionTitle>
      <CommandList commands={commands} />
    </Box>
  )
}

function CommandList({ commands }: { commands: readonly string[] }) {
  return (
    <Box flexDirection="column">
      {commands.map((command) => (
        <Text key={command} color="cyan">
          {`  ${command}`}
        </Text>
      ))}
    </Box>
  )
}
