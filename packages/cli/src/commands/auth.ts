import { spawn } from "node:child_process"
import { hostname } from "node:os"
import { createInterface } from "node:readline/promises"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { renderKeyValues, renderOutput, renderTable, style } from "../format"
import { CliError, fail, writeText } from "../output"
import {
  assertProfileName,
  profileSessionStore,
  readConfig,
  requireProfile,
  updateConfig,
} from "../profiles"
import { createInstanceApiClient } from "../run"
import {
  normalizeApiUrl,
  type SixbSessionTokens,
  signOutSession,
  startDeviceLogin,
} from "../session"

const LOGIN_HELP = `Usage:
  sixb login <api-url> [--profile <name>] [--token-stdin] [--json]

Sign in to a Sixb instance and save it as a profile. Pass --token-stdin to store an access
token from standard input (for CI or scripts).`

const LOGOUT_HELP = `Usage:
  sixb logout [--profile <name>] [--json]

Sign out of a saved profile and remove it from ~/.config/sixb/config.json.`

const PROFILE_HELP = `Usage:
  sixb profile list [--json]
  sixb profile show [name] [--json]
  sixb profile use <name> [--json]

Manage saved Sixb API profiles.`

export async function login(args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(LOGIN_HELP)
  const { positionals, options } = parseCommandArgs(
    args,
    { "--profile": "string", "--token-stdin": "boolean", "--json": "boolean" },
    "login",
    [0, 1]
  )

  let requested = positionals[0]?.trim() ?? ""
  if (!requested) {
    if (process.stdin.isTTY && process.stdout.isTTY && !options["--json"]) {
      requested = await promptForApiUrl()
    } else {
      fail("Usage: sixb login <api-url> [--profile <name>] [--token-stdin]")
    }
  }

  const apiUrl = normalizeApiUrl(requested)
  let token: string | undefined
  let session: SixbSessionTokens | undefined
  let projectId: string

  try {
    projectId = await fetchProjectId(apiUrl)
  } catch (error) {
    if (!isAuthorizationError(error)) throw error
    if (options["--token-stdin"]) {
      token = await readTokenFromStdin()
    } else {
      session = await authorizeDevice(apiUrl)
    }
    projectId = await fetchProjectId(apiUrl, token ?? session?.accessToken)
  }

  const profile = options["--profile"]?.trim() || projectId
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
  renderOutput(result, {
    json: options["--json"],
    renderText: () =>
      renderKeyValues({
        title: `Logged in with profile "${profile}"`,
        titleTone: "green",
        items: [
          { label: "Project", value: projectId },
          { label: "API", value: apiUrl },
          {
            label: "Authentication",
            value: session ? "signed in" : token ? "stored token" : "not required",
          },
        ],
      }),
  })
}

export async function logout(args: readonly string[]): Promise<void> {
  if (requestsHelp(args)) return writeText(LOGOUT_HELP)
  const { options } = parseCommandArgs(
    args,
    { "--profile": "string", "--json": "boolean" },
    "logout"
  )

  const config = await readConfig()
  const name = options["--profile"]?.trim() || config.currentProfile
  if (!name) fail("No active profile to log out of.")
  const stored = requireProfile(config, name)

  if (stored.session) {
    await signOutSession({
      baseUrl: stored.apiUrl,
      store: profileSessionStore(name),
    }).catch(() => {})
  }

  const next = await updateConfig((current) => {
    const remaining = Object.fromEntries(
      Object.entries(current.profiles).filter(([entry]) => entry !== name)
    )
    const remainingNames = Object.keys(remaining).sort()
    const currentProfile =
      current.currentProfile === name ? remainingNames[0] : current.currentProfile
    return {
      version: 1,
      ...(currentProfile ? { currentProfile } : {}),
      profiles: remaining,
    }
  })

  const result = {
    removed: name,
    ...(next.currentProfile ? { currentProfile: next.currentProfile } : {}),
  }
  renderOutput(result, {
    json: options["--json"],
    renderText: () =>
      renderKeyValues({
        title: `Logged out of profile "${name}"`,
        items: next.currentProfile
          ? [{ label: "Current profile", value: next.currentProfile }]
          : [{ label: "Current profile", value: "none" }],
      }),
  })
}

export async function profile(args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(PROFILE_HELP)

  if (sub === "list") {
    const { options } = parseCommandArgs(rest, { "--json": "boolean" }, "profile list")
    const config = await readConfig()
    const entries = Object.entries(config.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entry]) => ({
        name,
        current: name === config.currentProfile,
        projectId: entry.projectId,
        apiUrl: entry.apiUrl,
        authenticated: Boolean(entry.session ?? entry.token),
      }))
    return renderOutput(
      { currentProfile: config.currentProfile ?? null, profiles: entries },
      {
        json: options["--json"],
        renderText: () =>
          renderTable({
            subtitle: `${entries.length} saved`,
            headers: ["Profile", "Project", "API", "Auth"],
            rows: entries.map((entry) => [
              entry.current ? `${entry.name} *` : entry.name,
              entry.projectId,
              entry.apiUrl,
              entry.authenticated ? "signed in" : "none",
            ]),
            emptyMessage: "No saved profiles. Run `sixb login <api-url>`.",
          }),
      }
    )
  }

  if (sub === "show") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--json": "boolean" },
      "profile show",
      [0, 1]
    )
    const config = await readConfig()
    const name = positionals[0]?.trim() || config.currentProfile
    if (!name) fail("No active profile. Run `sixb login <api-url>`.")
    const entry = requireProfile(config, name)
    const result = {
      name,
      current: name === config.currentProfile,
      projectId: entry.projectId,
      apiUrl: entry.apiUrl,
      authenticated: Boolean(entry.session ?? entry.token),
    }
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: result.current ? `${name} (current)` : name,
          items: [
            { label: "Project", value: result.projectId },
            { label: "API", value: result.apiUrl },
            { label: "Authentication", value: result.authenticated ? "configured" : "none" },
          ],
        }),
    })
  }

  if (sub === "use") {
    const { positionals, options } = parseCommandArgs(
      rest,
      { "--json": "boolean" },
      "profile use",
      1
    )
    const name = positionals[0]?.trim() ?? ""
    const config = await readConfig()
    const entry = requireProfile(config, name)
    await updateConfig((current) => ({ ...current, currentProfile: name }))
    const result = { currentProfile: name, projectId: entry.projectId, apiUrl: entry.apiUrl }
    return renderOutput(result, {
      json: options["--json"],
      renderText: () =>
        renderKeyValues({
          title: `Switched to profile "${name}"`,
          titleTone: "green",
          items: [
            { label: "Project", value: entry.projectId },
            { label: "API", value: entry.apiUrl },
          ],
        }),
    })
  }

  fail(`Unknown profile command '${sub}'. Run 'sixb profile --help'.`)
}

async function promptForApiUrl(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = (await rl.question("API URL (default http://localhost:3001): ")).trim()
    return answer || "http://localhost:3001"
  } finally {
    rl.close()
  }
}

async function authorizeDevice(apiUrl: string): Promise<SixbSessionTokens> {
  const device = await startDeviceLogin({
    baseUrl: apiUrl,
    clientName: `sixb CLI on ${hostname()}`,
  })
  process.stderr.write(
    `\n  ${style.blue("→")} Opening ${device.verificationUriComplete}\n` +
      `    Confirm code: ${style.bold(device.userCode)}\n\n`
  )
  if (process.env.SIXB_CLI_NO_BROWSER !== "1") {
    openBrowser(device.verificationUriComplete)
  }
  process.stderr.write("Waiting for browser authorization...\n")
  return device.complete()
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]]
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

async function fetchProjectId(apiUrl: string, token?: string): Promise<string> {
  const api = createInstanceApiClient({
    baseUrl: apiUrl,
    ...(token ? { token } : {}),
  })
  const result = await api.get("/api/project")
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string" ||
    !result.id.trim()
  ) {
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
      fail("The token read from stdin is too large.")
    }
  }
  const token = value.trim()
  if (!token) fail("API token cannot be empty.")
  if (/\s/.test(token)) fail("API token cannot contain whitespace.")
  return token
}
