import { getProjectInfo } from "@sixb/client"
import {
  createCliSixbClient,
  resolveApiClientConfig,
  SixbApiError,
  unwrapSixbApiResult,
} from "../lib/api-client"
import { KeyValueResultView, renderStatic } from "../ui"

export interface AuthCommandOptions {
  readonly action?: string
  readonly apiUrl?: string
  readonly token?: string
  readonly json?: boolean
}

export async function runAuth(options: AuthCommandOptions = {}) {
  const action = options.action ?? "status"
  if (action !== "status") {
    throw new Error("Usage: sixb auth status")
  }

  const config = resolveApiClientConfig(options)
  if (!config.token) {
    await renderStatus({
      authenticated: false,
      apiUrl: config.apiUrl,
      apiUrlSource: config.apiUrlSource,
      message: "No API token found. Set SIXB_API_TOKEN or pass --token.",
      json: options.json,
    })
    process.exitCode = 1
    return
  }

  const client = createCliSixbClient(config)
  try {
    const project = unwrapSixbApiResult(await getProjectInfo({ client }))
    await renderStatus({
      authenticated: true,
      apiUrl: config.apiUrl,
      apiUrlSource: config.apiUrlSource,
      tokenSource: config.tokenSource,
      projectId: project.id,
      json: options.json,
    })
  } catch (error) {
    if (error instanceof SixbApiError && (error.status === 401 || error.status === 403)) {
      await renderStatus({
        authenticated: false,
        apiUrl: config.apiUrl,
        apiUrlSource: config.apiUrlSource,
        tokenSource: config.tokenSource,
        message: error.message,
        json: options.json,
      })
      process.exitCode = 1
      return
    }

    throw error
  }
}

async function renderStatus(input: {
  readonly authenticated: boolean
  readonly apiUrl: string
  readonly apiUrlSource: string
  readonly tokenSource?: string
  readonly projectId?: string
  readonly message?: string
  readonly json?: boolean
}) {
  if (input.json) {
    const { json: _json, ...payload } = input
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const items = [{ label: "API", value: `${input.apiUrl} (${input.apiUrlSource})` }]
  if (input.projectId) {
    items.push({ label: "Project", value: input.projectId })
  }
  if (input.tokenSource) {
    items.push({ label: "Token", value: input.tokenSource })
  }

  await renderStatic(
    <KeyValueResultView
      title={input.authenticated ? "Authenticated" : "Not authenticated"}
      titleColor={input.authenticated ? "green" : "red"}
      items={items}
      message={input.message}
    />
  )
}
