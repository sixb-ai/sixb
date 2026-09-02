import { CliError, createInstanceApiClient, writeJson } from "@sixb/cli-core"
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
  let projectId: string

  try {
    projectId = await fetchProject(apiUrl)
  } catch (error) {
    if (!isAuthorizationError(error)) throw error
    token = options.tokenStdin
      ? await readTokenFromStdin()
      : await authorizeDevice(apiUrl, options.profile?.trim() || "sixb CLI")
    projectId = await fetchProject(apiUrl, token)
  }

  const profile = options.profile?.trim() || projectId
  assertProfileName(profile)
  await updateConfig((config) => ({
    version: 1,
    currentProfile: profile,
    profiles: {
      ...config.profiles,
      [profile]: { apiUrl, projectId, ...(token ? { token } : {}) },
    },
  }))

  const result = { profile, projectId, apiUrl, authenticated: Boolean(token) }
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
        { label: "Authentication", value: token ? "stored token" : "not required" },
      ]}
    />
  )
}

interface DeviceAuthorizationStart {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUriComplete: string
  readonly expiresAt: string
  readonly interval: number
}

async function authorizeDevice(apiUrl: string, tokenName: string): Promise<string> {
  const api = createInstanceApiClient({ kind: "local", baseUrl: apiUrl })
  const start = parseDeviceAuthorizationStart(
    await api.post("/api/auth/device-authorizations", {
      clientName: "sixb CLI",
      tokenName,
      expiresIn: "90d",
    }),
    apiUrl
  )
  process.stderr.write(`Opening ${start.verificationUriComplete}\n`)
  process.stderr.write(`Confirm code: ${start.userCode}\n`)
  await openBrowser(start.verificationUriComplete)
  process.stderr.write("Waiting for browser authorization...\n")

  const serverDeadline = new Date(start.expiresAt).getTime()
  const deadline = Math.min(serverDeadline, Date.now() + 15 * 60 * 1000)
  const intervalMs = Math.max(1, Math.min(10, start.interval)) * 1000
  while (Date.now() < deadline) {
    const result = await api.post("/api/auth/device-authorizations/token", {
      deviceCode: start.deviceCode,
    })
    if (!isRecord(result) || typeof result.status !== "string") {
      throw new Error("[SixbCLI] The Sixb API returned an invalid device authorization response.")
    }
    if (result.status === "approved" && typeof result.accessToken === "string") {
      return requireToken(result.accessToken)
    }
    if (result.status === "denied") {
      throw new Error("[SixbCLI] Browser authorization was denied.")
    }
    if (result.status === "expired") {
      throw new Error("[SixbCLI] Browser authorization expired. Run `sixb login` again.")
    }
    if (result.status !== "pending") {
      throw new Error("[SixbCLI] The Sixb API returned an unknown authorization status.")
    }
    await Bun.sleep(intervalMs)
  }
  throw new Error("[SixbCLI] Browser authorization expired. Run `sixb login` again.")
}

function parseDeviceAuthorizationStart(value: unknown, apiUrl: string): DeviceAuthorizationStart {
  if (
    !isRecord(value) ||
    typeof value.deviceCode !== "string" ||
    !value.deviceCode ||
    value.deviceCode.length > 1_024 ||
    typeof value.userCode !== "string" ||
    !value.userCode ||
    typeof value.verificationUriComplete !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.interval !== "number" ||
    !Number.isFinite(value.interval) ||
    !Number.isFinite(new Date(value.expiresAt).getTime())
  ) {
    throw new Error("[SixbCLI] The Sixb API returned an invalid device authorization.")
  }
  const verificationUrl = new URL(value.verificationUriComplete)
  if (
    verificationUrl.origin !== new URL(apiUrl).origin ||
    (verificationUrl.protocol !== "http:" && verificationUrl.protocol !== "https:")
  ) {
    throw new Error("[SixbCLI] The device verification URL does not match the Sixb API origin.")
  }
  return {
    deviceCode: value.deviceCode,
    userCode: value.userCode,
    verificationUriComplete: value.verificationUriComplete,
    expiresAt: value.expiresAt,
    interval: value.interval,
  }
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
