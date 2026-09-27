import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { normalizeApiUrl } from "./api-client"

const CONFIG_DIRECTORY_MODE = 0o700
const CONFIG_FILE_MODE = 0o600
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export interface SixbProfile {
  readonly apiUrl: string
  readonly projectId: string
  /** A personal access token, for scripts and CI (`sixb login --token-stdin`). */
  readonly token?: string
  /** The session `sixb login` signs in through the browser. */
  readonly session?: SixbProfileSession
}

/** A signed-in session: the access token lasts minutes, and the refresh token renews it. */
export interface SixbProfileSession {
  readonly accessToken: string
  readonly refreshToken: string
  /** ISO time the access token expires. */
  readonly accessExpiresAt: string
}

/** The profile's session has been signed out, revoked, or left unused past its idle timeout. */
export class SessionEndedError extends Error {}

// Refresh a little early, so a command never starts with an access token about to expire.
const SESSION_REFRESH_MARGIN_MS = 60_000

export interface SixbConfigFile {
  readonly version: 1
  readonly currentProfile?: string
  readonly profiles: Readonly<Record<string, SixbProfile>>
}

export interface ProfileStoreOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly homeDirectory?: string
}

export interface ResolveProfileInput extends ProfileStoreOptions {
  readonly apiUrl?: string
  readonly token?: string
  readonly profile?: string
}

export interface ResolvedProfile {
  readonly apiUrl: string
  readonly token?: string
  readonly profile?: string
  readonly projectId?: string
  readonly source:
    | "api-url-flag"
    | "profile-flag"
    | "environment"
    | "profile-environment"
    | "current-profile"
    | "default"
  readonly tokenSource?: "--token" | "SIXB_API_TOKEN" | "SIXB_TOKEN" | "profile"
}

export function resolveConfigPath(options: ProfileStoreOptions = {}): string {
  const env = options.env ?? process.env
  const configuredRoot = nonblank(env.XDG_CONFIG_HOME)
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error("[SixbCLI] XDG_CONFIG_HOME must be an absolute path.")
  }
  const root = configuredRoot ?? join(options.homeDirectory ?? homedir(), ".config")
  return join(root, "sixb", "config.json")
}

export async function readConfig(options: ProfileStoreOptions = {}): Promise<SixbConfigFile> {
  const path = resolveConfigPath(options)
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isFileError(error, "ENOENT")) return emptyConfig()
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`[SixbCLI] Profile config '${path}' is not valid JSON.`)
  }
  return parseConfig(value, path)
}

export async function updateConfig(
  update: (config: SixbConfigFile) => SixbConfigFile,
  options: ProfileStoreOptions = {}
): Promise<SixbConfigFile> {
  const path = resolveConfigPath(options)
  const directory = dirname(path)
  const config = parseConfig(update(await readConfig(options)), path)
  const temporary = join(directory, `.config-${process.pid}-${randomUUID()}.tmp`)

  await mkdir(directory, { recursive: true, mode: CONFIG_DIRECTORY_MODE })
  await chmod(directory, CONFIG_DIRECTORY_MODE)
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: CONFIG_FILE_MODE,
    })
    await rename(temporary, path)
    await chmod(path, CONFIG_FILE_MODE)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }

  return config
}

export async function resolveProfile(input: ResolveProfileInput = {}): Promise<ResolvedProfile> {
  const env = input.env ?? process.env
  const explicitToken = nonblank(input.token)
  const explicitApiUrl = nonblank(input.apiUrl)
  if (explicitApiUrl) {
    return {
      apiUrl: normalizeApiUrl(explicitApiUrl),
      ...(explicitToken ? { token: explicitToken, tokenSource: "--token" as const } : {}),
      source: "api-url-flag",
    }
  }

  const config = await readConfig(input)
  const explicitProfile = nonblank(input.profile)
  if (explicitProfile) {
    const stored = requireProfile(config, explicitProfile)
    return resolvedStoredProfile(stored, explicitProfile, "profile-flag", explicitToken, input)
  }

  const environmentApiUrl = nonblank(env.SIXB_API_URL) ?? nonblank(env.SIXB_API_PUBLIC_ORIGIN)
  if (environmentApiUrl) {
    const environmentToken = resolveEnvironmentToken(env)
    return {
      apiUrl: normalizeApiUrl(environmentApiUrl),
      ...(explicitToken
        ? { token: explicitToken, tokenSource: "--token" as const }
        : environmentToken),
      source: "environment",
    }
  }

  const environmentProfile = nonblank(env.SIXB_PROFILE)
  if (environmentProfile) {
    const stored = requireProfile(config, environmentProfile)
    return resolvedStoredProfile(
      stored,
      environmentProfile,
      "profile-environment",
      explicitToken,
      input
    )
  }

  if (config.currentProfile) {
    const stored = requireProfile(config, config.currentProfile)
    return resolvedStoredProfile(
      stored,
      config.currentProfile,
      "current-profile",
      explicitToken,
      input
    )
  }

  return {
    apiUrl: "http://localhost:3002",
    ...(explicitToken ? { token: explicitToken, tokenSource: "--token" as const } : {}),
    source: "default",
  }
}

export function requireProfile(config: SixbConfigFile, name: string): SixbProfile {
  assertProfileName(name)
  const profile = config.profiles[name]
  if (!profile) throw new Error(`[SixbCLI] Profile '${name}' does not exist.`)
  return profile
}

export function assertProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      "[SixbCLI] Profile names must be 1-64 characters using letters, numbers, '.', '_', or '-'."
    )
  }
}

async function resolvedStoredProfile(
  stored: SixbProfile,
  profile: string,
  source: "profile-flag" | "profile-environment" | "current-profile",
  explicitToken: string | undefined,
  options: ProfileStoreOptions
): Promise<ResolvedProfile> {
  const { session, ...rest } = stored
  const base = { ...rest, profile, source }
  if (explicitToken) return { ...base, token: explicitToken, tokenSource: "--token" }
  if (session) {
    const token = await sessionAccessToken(profile, stored.apiUrl, session, options)
    return { ...base, token, tokenSource: "profile" }
  }
  return stored.token ? { ...base, tokenSource: "profile" } : base
}

async function sessionAccessToken(
  profile: string,
  apiUrl: string,
  session: SixbProfileSession,
  options: ProfileStoreOptions
): Promise<string> {
  if (Date.parse(session.accessExpiresAt) - Date.now() > SESSION_REFRESH_MARGIN_MS) {
    return session.accessToken
  }

  const response = await fetch(`${apiUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  })
  if (response.status === 401) {
    throw new SessionEndedError(
      `[SixbCLI] The sign-in for profile '${profile}' has ended. Run \`sixb login ${apiUrl} --profile ${profile}\` again.`
    )
  }
  if (!response.ok) {
    throw new Error(
      `[SixbCLI] Renewing the sign-in for profile '${profile}' failed with HTTP ${response.status}.`
    )
  }

  const next = parseSessionTokens(await response.json())
  await updateConfig(
    (config) => ({
      ...config,
      profiles: {
        ...config.profiles,
        [profile]: { ...requireProfile(config, profile), session: next },
      },
    }),
    options
  )
  return next.accessToken
}

/** Read the tokens the API returns when it signs a client in or refreshes its session. */
export function parseSessionTokens(value: unknown): SixbProfileSession {
  const record = asRecord(value)
  const accessToken = nonblankString(record.accessToken)
  const refreshToken = nonblankString(record.refreshToken)
  const expiresIn = record.expiresIn
  if (!accessToken || !refreshToken || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    throw new Error("[SixbCLI] The Sixb API returned invalid session tokens.")
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }
}

function resolveEnvironmentToken(
  env: Readonly<Record<string, string | undefined>>
): Pick<ResolvedProfile, "token" | "tokenSource"> {
  const apiToken = nonblank(env.SIXB_API_TOKEN)
  if (apiToken) return { token: apiToken, tokenSource: "SIXB_API_TOKEN" }
  const legacyToken = nonblank(env.SIXB_TOKEN)
  return legacyToken ? { token: legacyToken, tokenSource: "SIXB_TOKEN" } : {}
}

function emptyConfig(): SixbConfigFile {
  return { version: 1, profiles: {} }
}

function parseConfig(value: unknown, path: string): SixbConfigFile {
  const record = asRecord(value)
  if (record.version !== 1 || !isRecord(record.profiles)) {
    throw invalidConfig(path)
  }

  const profiles: Record<string, SixbProfile> = {}
  for (const [name, rawProfile] of Object.entries(record.profiles)) {
    assertProfileName(name)
    const profile = asRecord(rawProfile)
    const apiUrl = nonblankString(profile.apiUrl)
    const projectId = nonblankString(profile.projectId)
    const token = profile.token === undefined ? undefined : nonblankString(profile.token)
    const session = profile.session === undefined ? undefined : parseStoredSession(profile.session)
    if (
      !apiUrl ||
      !projectId ||
      (profile.token !== undefined && !token) ||
      (profile.session !== undefined && !session) ||
      (token && session)
    ) {
      throw invalidConfig(path)
    }
    profiles[name] = {
      apiUrl: normalizeApiUrl(apiUrl),
      projectId,
      ...(token ? { token } : {}),
      ...(session ? { session } : {}),
    }
  }

  const currentProfile =
    record.currentProfile === undefined ? undefined : nonblankString(record.currentProfile)
  if (
    (record.currentProfile !== undefined && !currentProfile) ||
    (currentProfile && !profiles[currentProfile])
  ) {
    throw invalidConfig(path)
  }

  return {
    version: 1,
    ...(currentProfile ? { currentProfile } : {}),
    profiles,
  }
}

function parseStoredSession(value: unknown): SixbProfileSession | undefined {
  const record = asRecord(value)
  const accessToken = nonblankString(record.accessToken)
  const refreshToken = nonblankString(record.refreshToken)
  const accessExpiresAt = nonblankString(record.accessExpiresAt)
  if (
    !accessToken ||
    !refreshToken ||
    !accessExpiresAt ||
    Number.isNaN(Date.parse(accessExpiresAt))
  ) {
    return undefined
  }
  return { accessToken, refreshToken, accessExpiresAt }
}

function invalidConfig(path: string): Error {
  return new Error(`[SixbCLI] Profile config '${path}' has an invalid shape.`)
}

function nonblank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function nonblankString(value: unknown): string | undefined {
  return typeof value === "string" ? nonblank(value) : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFileError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code
}
