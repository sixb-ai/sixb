import type { ApiClient } from "../api-client"
import { isHelp } from "../arguments"
import { renderKeyValues, renderOutput } from "../format"
import { CliError, EXIT_API, fail, INSTANCE_CLI_VERSION, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord } from "./shared"

/** Stable JSON emitted by `sixb status`. */
export interface StatusReport {
  readonly ok: true
  readonly connected: true
  readonly apiUrl: string
  readonly cli: { readonly version: string }
  readonly runtime: {
    readonly name: "bun" | "node"
    readonly version: string
  }
  readonly project: {
    readonly id: string
    readonly locale?: string
    readonly timeZone?: string
  }
  readonly authenticated?: boolean
  readonly profile?: string
  readonly source?: string
}

export interface StatusContext {
  readonly apiUrl?: string
  readonly authenticated?: boolean
  readonly profile?: string
  readonly source?: string
}

export async function fetchStatus(
  api: ApiClient,
  context: StatusContext = {}
): Promise<StatusReport> {
  const project = asRecord(await api.get("/api/project"))
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid project." },
      EXIT_API
    )
  }
  return {
    ok: true,
    connected: true,
    apiUrl: context.apiUrl ?? api.baseUrl,
    cli: { version: INSTANCE_CLI_VERSION },
    runtime: javascriptRuntime(),
    project: {
      id: project.id,
      ...(typeof project.locale === "string" ? { locale: project.locale } : {}),
      ...(typeof project.timeZone === "string" ? { timeZone: project.timeZone } : {}),
    },
    ...(context.authenticated === undefined ? {} : { authenticated: context.authenticated }),
    ...(context.profile === undefined ? {} : { profile: context.profile }),
    ...(context.source === undefined ? {} : { source: context.source }),
  }
}

export async function status(
  api: ApiClient,
  args: readonly string[],
  context: StatusContext = {}
): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.status)
  if (args.some((arg) => arg !== "--json")) fail("status accepts no arguments but --json.")
  const report = await fetchStatus(api, context)
  renderOutput(report, {
    json: args.includes("--json"),
    renderText: () =>
      renderKeyValues({
        title: "Connected",
        titleTone: "green",
        items: [
          ...(report.profile ? [{ label: "Profile", value: report.profile }] : []),
          { label: "Project", value: report.project.id },
          { label: "API", value: report.apiUrl },
          ...(report.authenticated === undefined
            ? []
            : [
                {
                  label: "Authentication",
                  value: report.authenticated ? "token" : "not required",
                },
              ]),
          { label: "Runtime", value: `${report.runtime.name} ${report.runtime.version}` },
        ],
      }),
  })
}

function javascriptRuntime(): StatusReport["runtime"] {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}
