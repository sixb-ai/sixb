import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
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
    token = options.tokenStdin ? await readTokenFromStdin() : await promptForToken()
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

async function promptForToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "[SixbCLI] This API requires authentication. Pipe a token to `sixb login <api-url> --token-stdin`."
    )
  }

  let muted = false
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk)
      callback()
    },
  })
  const readline = createInterface({ input: process.stdin, output, terminal: true })
  try {
    process.stderr.write("API token: ")
    muted = true
    const value = await readline.question("")
    muted = false
    process.stderr.write("\n")
    return requireToken(value)
  } finally {
    readline.close()
  }
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
