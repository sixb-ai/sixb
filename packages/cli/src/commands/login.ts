import { hostname } from "node:os"
import { CliError, createInstanceApiClient, writeJson } from "@sixb/cli-core"
import { type SixbSessionTokens, signOutSixbSession, startSixbDeviceLogin } from "@sixb/client"
import { normalizeApiUrl } from "../lib/api-client"
import { openUrl } from "../lib/open-url"
import { assertProfileName, readConfig, type SixbProfile, updateConfig } from "../lib/profiles"
import { keyValueResultView, renderStatic, withTask } from "../ui"
import { canRunLive } from "../ui/live/can-run-live"
import { glyph, paint, palette, tone } from "../ui/theme"

export interface LoginCommandOptions {
  readonly apiUrl?: string
  readonly profile?: string
  readonly tokenStdin?: boolean
  readonly json?: boolean
}

export async function runLogin(options: LoginCommandOptions = {}): Promise<void> {
  const requested =
    options.apiUrl?.trim() || (canRunLive() && !options.json ? await askForApiUrl() : "")
  if (!requested) {
    throw new Error("Usage: sixb login <api-url> [--profile <name>] [--token-stdin]")
  }

  const apiUrl = normalizeApiUrl(requested)
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
      session = await authorizeDevice(apiUrl, options.json === true)
    }
    projectId = await fetchProject(apiUrl, token ?? session?.accessToken)
  }

  const profile = options.profile?.trim() || projectId
  assertProfileName(profile)
  const replaced = (await readConfig()).profiles[profile]
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

  // The session this login replaced would stay live in production, and so would what was taken
  // with it, such as a branch's copy: it signs out.
  if (replaced?.session) await signOutReplaced(replaced)

  const result = { profile, projectId, apiUrl, authenticated: Boolean(token ?? session) }
  if (options.json) {
    writeJson(result)
    return
  }

  await renderStatic(
    keyValueResultView({
      title: `Logged in with profile "${profile}"`,
      items: [
        { label: "Project", value: projectId },
        { label: "API", value: apiUrl },
        {
          label: "Authentication",
          value: session ? "signed in" : token ? "stored token" : "not required",
        },
      ],
    })
  )
}

/** Best effort: the new login holds whatever happens to the old session. */
async function signOutReplaced(replaced: SixbProfile): Promise<void> {
  let tokens = replaced.session ?? null

  try {
    await signOutSixbSession({
      baseUrl: replaced.apiUrl,
      // The profile already holds the new login: the old session lives here only.
      store: {
        load: () => tokens,
        save: (renewed) => {
          tokens = renewed
        },
        clear: () => {
          tokens = null
        },
      },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
    })
  } catch (error) {
    process.stderr.write(
      `[SixbCLI] Could not sign out the session this login replaced: ${error instanceof Error ? error.message : String(error)}. Revoke it from your account's sessions in the app.\n`
    )
  }
}

async function askForApiUrl(): Promise<string> {
  const { promptText } = await import("../ui/live/prompt")
  return promptText({
    command: "login",
    label: "API URL",
    defaultValue: "http://localhost:3001",
    hint: "Where the Sixb API answers, such as https://api.example.com",
    validate: (value) => (URL.canParse(value) ? null : "That is not a URL."),
  })
}

async function authorizeDevice(apiUrl: string, json: boolean): Promise<SixbSessionTokens> {
  const login = await startSixbDeviceLogin({
    baseUrl: apiUrl,
    clientName: `sixb CLI on ${hostname()}`,
  })
  // On stderr, so `--json` output stays only the result.
  process.stderr.write(
    `\n  ${tone.blue(glyph.arrow)} Opening ${tone.url(login.verificationUriComplete)}\n` +
      `    Confirm code: ${paint(login.userCode, { color: palette.blue, bold: true })}\n\n`
  )
  if (process.env.SIXB_CLI_NO_BROWSER !== "1") await openUrl(login.verificationUriComplete)
  if (json || !process.stdout.isTTY) {
    process.stderr.write("Waiting for browser authorization...\n")
    return login.complete()
  }
  return withTask("login", "Waiting for you to approve it in the browser", () => login.complete())
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
