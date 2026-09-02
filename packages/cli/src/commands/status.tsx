import { CliError, createInstanceApiClient, writeJson } from "@sixb/cli-core"
import { resolveProfile } from "../lib/profiles"
import { KeyValueResultView, renderStatic } from "../ui"

export interface StatusCommandOptions {
  readonly apiUrl?: string
  readonly token?: string
  readonly profile?: string
  readonly json?: boolean
}

export async function runStatus(options: StatusCommandOptions = {}): Promise<void> {
  const resolved = await resolveProfile(options)
  try {
    const project = await createInstanceApiClient({
      kind: "local",
      baseUrl: resolved.apiUrl,
      ...(resolved.token ? { token: resolved.token } : {}),
      ...(resolved.profile ? { profile: resolved.profile } : {}),
    }).get("/api/project")
    const projectId = projectIdFrom(project)
    await renderStatus({
      connected: true,
      authenticated: Boolean(resolved.token),
      apiUrl: resolved.apiUrl,
      source: resolved.source,
      ...(resolved.profile ? { profile: resolved.profile } : {}),
      projectId,
      json: options.json,
    })
  } catch (error) {
    if (!(error instanceof CliError) || (error.body.status !== 401 && error.body.status !== 403)) {
      throw error
    }
    await renderStatus({
      connected: true,
      authenticated: false,
      apiUrl: resolved.apiUrl,
      source: resolved.source,
      ...(resolved.profile ? { profile: resolved.profile } : {}),
      message: error.message,
      json: options.json,
    })
    process.exitCode = 1
  }
}

async function renderStatus(input: {
  readonly connected: boolean
  readonly authenticated: boolean
  readonly apiUrl: string
  readonly source: string
  readonly profile?: string
  readonly projectId?: string
  readonly message?: string
  readonly json?: boolean
}): Promise<void> {
  if (input.json) {
    const { json: _json, ...result } = input
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title={input.message ? "Authentication failed" : "Connected"}
      titleColor={input.message ? "red" : "green"}
      items={[
        ...(input.profile ? [{ label: "Profile", value: input.profile }] : []),
        ...(input.projectId ? [{ label: "Project", value: input.projectId }] : []),
        { label: "API", value: input.apiUrl },
        {
          label: "Authentication",
          value: input.authenticated ? "token" : input.message ? "failed" : "not required",
        },
      ]}
      message={input.message}
    />
  )
}

function projectIdFrom(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id.trim()
  ) {
    throw new Error("[SixbCLI] The Sixb API returned project metadata without a project id.")
  }
  return value.id.trim()
}
