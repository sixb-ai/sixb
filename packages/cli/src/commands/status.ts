import { CliError, createInstanceApiClient, fetchStatus, writeJson } from "@sixb/cli-core"
import { resolveProfile } from "../lib/profiles"
import { keyValueResultView, renderStatic } from "../ui"

export interface StatusCommandOptions {
  readonly apiUrl?: string
  readonly token?: string
  readonly profile?: string
  readonly json?: boolean
}

export async function runStatus(options: StatusCommandOptions = {}): Promise<void> {
  const resolved = await resolveProfile(options)
  const api = createInstanceApiClient({
    baseUrl: resolved.apiUrl,
    ...(resolved.token ? { token: resolved.token } : {}),
    ...(resolved.runId ? { runId: resolved.runId } : {}),
  })
  try {
    const report = await fetchStatus(api, {
      apiUrl: resolved.apiUrl,
      authenticated: Boolean(resolved.token),
      ...(resolved.profile ? { profile: resolved.profile } : {}),
      source: resolved.source,
    })
    if (options.json) {
      writeJson(report)
      return
    }

    await renderStatic(
      keyValueResultView({
        title: "Connected",
        titleColor: "green",
        items: [
          ...(report.profile ? [{ label: "Profile", value: report.profile }] : []),
          { label: "Project", value: report.project.id },
          { label: "API", value: report.apiUrl },
          {
            label: "Authentication",
            value: report.authenticated ? "token" : "not required",
          },
        ],
      })
    )
  } catch (error) {
    if (!(error instanceof CliError) || (error.body.status !== 401 && error.body.status !== 403)) {
      throw error
    }
    const failed = {
      ok: false,
      connected: true,
      authenticated: false,
      apiUrl: resolved.apiUrl,
      source: resolved.source,
      ...(resolved.profile ? { profile: resolved.profile } : {}),
      message: error.message,
    }
    if (options.json) {
      writeJson(failed)
    } else {
      await renderStatic(
        keyValueResultView({
          title: "Authentication failed",
          titleColor: "red",
          items: [
            ...(resolved.profile ? [{ label: "Profile", value: resolved.profile }] : []),
            { label: "API", value: resolved.apiUrl },
            { label: "Authentication", value: "failed" },
          ],
          message: error.message,
        })
      )
    }
    process.exitCode = 1
  }
}
