import type {
  DeployAccessKey,
  DeployCheck,
  DeployCommand,
  DeployRelease,
  DeployStatus,
} from "@sixb/core/deploy"
import {
  type Block,
  header,
  headline,
  isUrl,
  marked,
  pad,
  plural,
  type Row,
  rows,
  type Status,
  screen,
  section,
  stack,
  table,
} from "./layout"
import { glyph, paint, palette, tone } from "./theme"

export function deployReleaseView({
  release,
  configPath,
}: {
  release: DeployRelease
  configPath: string
}): string {
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
  const continuation = " ".repeat(labelWidth)

  const services = release.services.map((service) => {
    const first = service.http
      ? `${tone.url(service.http.publicOrigin)}${" ".repeat(originWidth - service.http.publicOrigin.length + 2)}${tone.muted(`${glyph.arrow} ${service.http.host}:${service.http.port}`)}`
      : tone.muted(describeDeployProcess(service))
    const extra = [
      tone.faint(`$ ${formatDeployCommand(service.command)}`),
      ...Object.entries(service.env)
        .filter(([key, value]) => release.env[key] !== value)
        .map(([key, value]) => tone.muted(`${key}=${value}`)),
    ]
    return [
      `${tone.strong(pad(service.name, labelWidth))}${first}`,
      ...extra.map((line) => `${continuation}${line}`),
    ].join("\n")
  })

  return screen(
    stack(
      header("deploy --dry-run", release.name),
      tone.muted(`${release.target.kind} ${release.target.location} ${glyph.dot} ${configPath}`)
    ),
    section("Services", services.join("\n")),
    section(
      "Steps",
      steps
        .map(
          (step) =>
            `${tone.strong(pad(step.label, labelWidth))}${step.commands
              .map(formatDeployCommand)
              .join(tone.faint(` ${glyph.arrow} `))}`
        )
        .join("\n")
    ),
    section(
      "Environment",
      stack(
        ...env.map(([key, value]) => `${key}${tone.faint("=")}${value}`),
        origins.size > 0 ? tone.muted("plus the public origins above") : null
      )
    ),
    headline("idle", "Nothing was deployed", "--json prints the full release")
  )
}

/** The plain line a finished step prints where there is no live view, and in CI logs. */
export function deployStepLine(label: string, seconds: string): string {
  return `${tone.ok(glyph.ok)} ${label} ${tone.faint(`(${seconds}s)`)}`
}

export function deployCompleteView({
  release,
  commit,
  ref,
  seconds,
}: {
  release: DeployRelease
  commit: string
  ref: string
  seconds?: number
}): string {
  const urls = release.services.flatMap((service) =>
    service.http ? [{ label: service.name, value: service.http.publicOrigin }] : []
  )
  return screen(
    stack(
      headline(
        "ok",
        `${release.name} deployed`,
        seconds === undefined ? undefined : `${seconds.toFixed(1)}s`
      ),
      `  ${tone.muted(`${commit.slice(0, 12)} ${glyph.dot} ${ref} ${glyph.dot} ${release.target.kind} ${release.target.location}`)}`
    ),
    urls.length > 0 ? rows(urls) : null
  )
}

export function deployStatusView({
  name,
  location,
  status,
}: {
  name: string
  location: string
  status: DeployStatus
}): string {
  if (!status.release) {
    return screen(
      header("deploy status", name),
      headline("idle", `Nothing is deployed on ${location} yet.`),
      `${tone.faint("$")} ${tone.blue("sixb deploy")}`
    )
  }
  const healthy =
    status.running && status.processes.every((process) => process.status === "running")
  const release = status.release
  return screen(
    stack(
      headline(
        healthy ? "live" : "warn",
        `${name} ${healthy ? "is running" : status.running ? "needs attention" : "is stopped"}`
      ),
      `  ${tone.muted(`${release.commit.slice(0, 12)} ${glyph.dot} ${release.ref} ${glyph.dot} deployed ${formatAge(release.deployedAt)} by ${release.deployedBy} ${glyph.dot} ${location}`)}`
    ),
    status.processes.length > 0
      ? table(
          ["", "service", "pid", "cpu", "memory", "restarts", "up"],
          status.processes.map((process) => [
            process.status === "running" ? tone.ok(glyph.live) : tone.warn(glyph.idle),
            process.instance === 0 ? process.service : `${process.service}#${process.instance}`,
            process.pid === undefined ? "-" : String(process.pid),
            process.cpuPercent === undefined ? "-" : `${process.cpuPercent.toFixed(1)}%`,
            process.memoryBytes === undefined ? "-" : formatBytes(process.memoryBytes),
            process.restarts > 0 ? tone.warn(String(process.restarts)) : String(process.restarts),
            process.status === "running" && process.startedAt
              ? formatAge(process.startedAt, "")
              : tone.warn(process.status),
          ])
        )
      : tone.muted("The supervisor is not running."),
    stack(
      ...status.processes
        .filter((process) => process.lastError)
        .map((process) =>
          marked(tone.warn(glyph.warn), `${process.service}: ${process.lastError}`, tone.muted)
        )
    ) || null
  )
}

const CHECK_STATUS = {
  ok: "ok",
  fixable: "warn",
  manual: "idle",
  warning: "warn",
} as const satisfies Record<DeployCheck["status"], Status>

export function deployChecksView({
  name,
  location,
  checks,
}: {
  name: string
  location: string
  checks: readonly DeployCheck[]
}): string {
  const blocking = checks.filter((check) => check.status === "fixable" || check.status === "manual")
  const warnings = checks.filter((check) => check.status === "warning")
  const next = blocking.some((check) => check.status === "fixable")
    ? "sixb deploy setup"
    : blocking.length > 0
      ? "the steps above, then sixb deploy check"
      : "sixb deploy"

  return screen(
    header("deploy check", location),
    rows(
      checks.map(
        (check): Row => ({
          label: check.label,
          value: check.detail,
          status: CHECK_STATUS[check.status],
          ...(check.remedy ? { notes: [check.remedy], noteStyle: tone.blue } : {}),
        })
      )
    ),
    blocking.length > 0
      ? headline("warn", `${name} · ${blocking.length} to fix before deploying`)
      : headline(
          "ok",
          `${name} is ready to deploy`,
          warnings.length > 0 ? `${warnings.length} to look at` : undefined
        ),
    `${tone.muted("Next")}  ${next.startsWith("sixb") ? tone.blue(next) : next}`
  )
}

export function deployCiView({
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
}): string {
  const items: Row[] = [
    { label: "Key", status: "ok", value: credential },
    { label: "Secrets", status: "ok", value: secrets.join(", ") },
    {
      label: "Older keys",
      status: "ok",
      value:
        retired.length === 0
          ? "none to revoke"
          : `revoked ${retired.map((key) => key.fingerprint).join(", ")}`,
    },
    {
      label: "Workflow",
      status: "ok",
      value: {
        written: workflow.path,
        unchanged: `${workflow.path} (unchanged)`,
        kept: `${workflow.path} (yours, kept: it differs from what this command writes; delete it and run again to start over)`,
      }[workflow.state],
    },
    ...(token
      ? [
          {
            label: "Token",
            status: "idle" as const,
            value: `${token.submodules.map((submodule) => submodule.path).join(", ")} ${token.submodules.length === 1 ? "is" : "are"} private, and CI cannot read ${token.submodules.length === 1 ? "it" : "them"} with its own token.`,
            notes: [
              `Create a fine-grained token with Contents: read on ${token.submodules.map((submodule) => submodule.repo ?? submodule.url).join(", ")}, then run \`gh secret set ${token.name} --env ${environment} --repo ${repo}\`.`,
            ],
            noteStyle: tone.blue,
          },
        ]
      : []),
  ]
  const next =
    workflow.state === "written"
      ? `commit ${workflow.path} and push to ${branch}.`
      : `push to ${branch} to deploy.`

  return screen(
    stack(header("deploy ci", repo), tone.muted(`environment ${environment}`)),
    rows(items),
    headline(
      token ? "warn" : "ok",
      `${name} deploys from GitHub Actions on every push to ${branch}`
    ),
    `${tone.muted("Next")}  ${next}`
  )
}

export function deployAccessView({
  title,
  keys,
}: {
  title: string
  keys: readonly DeployAccessKey[]
}): string {
  // Two lines a key: a fingerprint and a long comment do not fit side by side in 80 columns.
  const list: Block =
    keys.length === 0
      ? tone.muted("No keys.")
      : keys
          .map((key) =>
            stack(
              `${tone.strong(key.comment || "(no comment)")}${key.restricted ? tone.warn("  restricted") : ""}`,
              tone.muted(`${key.type} ${key.fingerprint}`)
            )
          )
          .join("\n")
  return screen(headline("ok", title), list)
}

export function deployLiveUrls(release: DeployRelease): string {
  return release.services
    .flatMap((service) => (service.http ? [service.http.publicOrigin] : []))
    .filter(isUrl)
    .map((url) => paint(url, { color: palette.blue, underline: true }))
    .join("  ")
}

export function formatAge(iso: string, suffix = " ago"): string {
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
  const count = plural(service.instances, "process", "processes")
  if (service.kind === "script") return `project script · ${count}`
  // `worker-group` without worker types runs every type the project registers work for.
  const namesWorkerTypes = service.command.args[1] && !service.command.args[1].startsWith("-")
  if (service.kind === "workers" && !namesWorkerTypes) {
    return `${count} · every worker type the project registers`
  }
  return count
}

export function formatDeployCommand(command: DeployCommand): string {
  return [command.program, ...command.args].join(" ")
}
