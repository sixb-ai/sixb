import { hostname } from "node:os"
import { CliError, createInstanceApiClient, writeJson } from "@sixb/cli-core"
import { type SixbSessionTokens, startSixbDeviceLogin } from "@sixb/client"
import { normalizeApiUrl } from "../lib/api-client"
import { assertProfileName, updateConfig } from "../lib/profiles"
import { KeyValueResultView, renderStatic } from "../ui"

export interface LoginCommandOptions {
  readonly apiUrl?: string
  readonly profile?: string
  readonly tokenStdin?: boolean
  readonly json?: boolean
}

export async function runLogin(options: LoginCommandOptions = {}): Promise<void> {
  if (!options.apiUrl?.trim()) {
    throw new Error("Usage: sixb login <api-url> [--profile <name>] [--token-stdin]")
  }

  const apiUrl = normalizeApiUrl(options.apiUrl)
  let token: string | undefined
  let session: SixbSessionTokens | undefined
  let projectId: string

  try {
    projectId = await fetchProject(apiUrl)
  } catch (error) {
    if (!isAuthorizationError(error)) throw error
    if (options.tokenStdin) {
      token = await readTokenFromStdin()
    } else {
      session = await authorizeDevice(apiUrl)
    }
    projectId = await fetchProject(apiUrl, token ?? session?.accessToken)
  }

  const profile = options.profile?.trim() || projectId
  assertProfileName(profile)
  await updateConfig((config) => ({
    version: 1,
    currentProfile: profile,
    profiles: {
      ...config.profiles,
      [profile]: {
        apiUrl,
        projectId,
        ...(token ? { token } : {}),
        ...(session ? { session } : {}),
      },
    },
  }))

  const result = { profile, projectId, apiUrl, authenticated: Boolean(token ?? session) }
  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    <KeyValueResultView
      title={`Logged in with profile "${profile}"`}
      items={[
        { label: "Project", value: projectId },
        { label: "API", value: apiUrl },
        {
          label: "Authentication",
          value: session ? "signed in" : token ? "stored token" : "not required",
        },
      ]}
    />
  )
}

async function authorizeDevice(apiUrl: string): Promise<SixbSessionTokens> {
  const login = await startSixbDeviceLogin({
    baseUrl: apiUrl,
    clientName: `sixb CLI on ${hostname()}`,
  })
  process.stderr.write(`Opening ${login.verificationUriComplete}\n`)
  process.stderr.write(`Confirm code: ${login.userCode}\n`)
  await openBrowser(login.verificationUriComplete)
  process.stderr.write("Waiting for browser authorization...\n")
  return login.complete()
}

async function openBrowser(url: string): Promise<void> {
  if (process.env.SIXB_CLI_NO_BROWSER === "1") return
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd.exe", "/c", "start", "", url]
        : ["xdg-open", url]
  try {
    const process = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" })
    await process.exited
  } catch {
    // The URL and confirmation code were printed, so manual completion remains available.
  }
}

async function fetchProject(apiUrl: string, token?: string): Promise<string> {
  const api = createInstanceApiClient({
    kind: "local",
    baseUrl: apiUrl,
    ...(token ? { token } : {}),
  })
  const result = await api.get("/api/project")
  if (!isRecord(result) || typeof result.id !== "string" || !result.id.trim()) {
    throw new Error("[SixbCLI] The Sixb API returned project metadata without a project id.")
  }
  return result.id.trim()
}

function isAuthorizationError(error: unknown): boolean {
  return error instanceof CliError && (error.body.status === 401 || error.body.status === 403)
}

async function readTokenFromStdin(): Promise<string> {
  let value = ""
  for await (const chunk of process.stdin) {
    value += chunk.toString()
    if (value.length > 16_384) {
      throw new Error("[SixbCLI] The token read from stdin is too large.")
    }
  }
  return requireToken(value)
}

function requireToken(value: string): string {
  const token = value.trim()
  if (!token) throw new Error("[SixbCLI] API token cannot be empty.")
  if (/\s/.test(token)) throw new Error("[SixbCLI] API token cannot contain whitespace.")
  return token
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
