import type {
  ConnectorConnectionSelector,
  SandboxOAuthConnector,
  SandboxRequestCredential,
  SandboxSourceAuth,
  SandboxSourceAuthInput,
  SandboxSourceCredentials,
} from "@sixb/core/sandboxes"
import { createAppJwtSigner } from "./app-auth"

export interface GitHubAppOptions {
  readonly appId: string
  /**
   * PEM-encoded RSA private key. Newlines escaped as a literal `\n`, as environment variables often
   * hold it, are accepted. Never supplied to a sandbox or resolver result.
   */
  readonly privateKey: string
}

export interface GitHubOAuthSandboxOptions {
  /** Registered GitHub OAuth connector whose connection supplies the user's token. */
  readonly connector: SandboxOAuthConnector
  /** GitHub App client ID used to scope and revoke per-run tokens. */
  readonly clientId: string
  /**
   * GitHub App client secret used to scope and revoke per-run tokens.
   * Never supplied to a sandbox or resolver result.
   */
  readonly clientSecret: string
  /**
   * Connection slot to read for the user (or project when `owner` is `"project"`).
   * Defaults to `"default"`.
   */
  readonly slot?: string
  /**
   * Whose connection to use: `"user"` (the default) uses the run requester's personal connection
   * so commits and pushes come from them; `"project"` uses a shared project connection.
   */
  readonly owner?: "user" | "project"
  /**
   * Optional fallback used only when `owner` is `"user"` and no user requested the run (such as a
   * scheduled or event-driven workflow step). Never used when a user requested the run and lacks a
   * connection, so a person's run never silently commits as a bot.
   */
  readonly fallback?: SandboxSourceAuth
}

const API = "https://api.github.com"
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Value of GH_TOKEN and GITHUB_TOKEN inside the sandbox. GitHub tools refuse to start without a
 * token, but the real one never enters the sandbox: the host replaces this value in the
 * Authorization header of requests to the GitHub API. Anywhere else, GitHub rejects it.
 */
const TOKEN_PLACEHOLDER = "placeholder-replaced-outside-the-sandbox"

/**
 * What each source access may do. `permissions` is requested for the scoped token and
 * checked in GitHub's answer; `label` names them when the App or account has not granted them.
 */
const ACCESS = {
  read: { permissions: { contents: "read" }, label: "Contents: read" },
  write: {
    permissions: { contents: "write", pull_requests: "write" },
    label: "Contents and Pull requests: write",
  },
} as const

type Access = keyof typeof ACCESS

type GitIdentity = Readonly<Record<string, string>>

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** GitHub.com Git access through short-lived, repository-scoped installation tokens. */
export function githubApp(options: GitHubAppOptions): SandboxSourceAuth {
  const signer = createAppJwtSigner(options)
  const { appId } = signer
  const jwt = () => signer.signJwt()

  // The bot identity belongs to the App, not to a repository, so one lookup serves every run of
  // this instance. Concurrent runs share the pending lookup, which reads the bot user with the
  // first caller's installation token. A failed lookup is forgotten so that a later run retries.
  let lookup: Promise<GitIdentity> | undefined
  const gitIdentity = (token: string) => {
    if (!lookup) {
      const pending = botIdentity(appId, jwt(), token)
      lookup = pending
      pending.catch(() => {
        if (lookup === pending) lookup = undefined
      })
    }

    return lookup
  }

  return Object.freeze({
    async authorize({ source, signal }: SandboxSourceAuthInput): Promise<SandboxSourceCredentials> {
      const { owner, repo, path } = repository(source.url)
      const access = parseAccess(source)
      const installation = await request(`/repos/${owner}/${repo}/installation`, {
        authorization: `Bearer ${jwt()}`,
        method: "GET",
        signal,
      })
      if (
        !record(installation) ||
        !Number.isSafeInteger(installation.id) ||
        Number(installation.id) <= 0
      ) {
        throw new Error("[SixbGitHub] Repository installation response is invalid.")
      }

      const { permissions, label } = ACCESS[access]
      const grant = await request(`/app/installations/${installation.id}/access_tokens`, {
        authorization: `Bearer ${jwt()}`,
        method: "POST",
        signal,
        body: { repositories: [repo], permissions },
        failures: {
          // GitHub answers 422 when the installation has not granted a requested permission.
          422:
            `[SixbGitHub] The App installation does not grant the permissions this workspace ` +
            `needs (${label}). Update the App's permissions and approve them on the installation.`,
        },
      })
      if (
        !record(grant) ||
        typeof grant.token !== "string" ||
        !grant.token ||
        /[\r\n]/.test(grant.token)
      ) {
        throw new Error("[SixbGitHub] Installation token response is invalid.")
      }
      const token = grant.token
      let revoked = false
      const revoke = async () => {
        if (revoked) return
        // Cleanup must remain possible after the run's signal was aborted.
        await request("/installation/token", {
          authorization: `Bearer ${token}`,
          method: "DELETE",
          revokeStatuses: [204, 401],
        })
        revoked = true
      }
      const expiresAt = new Date(typeof grant.expires_at === "string" ? grant.expires_at : "")
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() + 60_000 ||
        !grantsExactly(grant.permissions, permissions) ||
        !Array.isArray(grant.repositories) ||
        grant.repositories.length !== 1 ||
        !record(grant.repositories[0]) ||
        typeof grant.repositories[0].full_name !== "string" ||
        grant.repositories[0].full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
        signal.aborted
      ) {
        await revokeAfterFailure(revoke, "Installation token")
        throw new Error(
          "[SixbGitHub] Installation token did not match the requested repository, permissions or lifetime."
        )
      }

      let identity: GitIdentity
      try {
        identity = await gitIdentity(token)
      } catch (error) {
        await revokeAfterFailure(revoke, "Installation token")
        throw error
      }

      // The shared lookup does not follow this run's signal: check it again before handing out
      // access that nobody would revoke.
      if (signal.aborted) {
        await revokeAfterFailure(revoke, "Installation token")
        signal.throwIfAborted()
      }

      return {
        requests: gitRequests(path, token, access),
        env: guestEnv(identity, access),
        expiresAt,
        revoke,
      }
    },
  })
}

/**
 * GitHub.com Git access through a connected user's (or project's) GitHub App OAuth token,
 * narrowed per run to one repository and the requested permissions so commits and pushes come
 * from the connected user while keeping repository isolation and per-run revocation.
 */
export function githubOAuth(options: GitHubOAuthSandboxOptions): SandboxSourceAuth {
  const connector = parseOAuthConnector(options.connector)
  const clientId = parseClientId(options.clientId)
  const clientSecret = parseClientSecret(options.clientSecret)
  const slot = parseSlot(options.slot)
  const ownerMode = parseOwnerMode(options.owner)
  const fallback = parseFallback(options.fallback)
  const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
  const encodedClientId = encodeURIComponent(clientId)

  return Object.freeze({
    async authorize(input: SandboxSourceAuthInput): Promise<SandboxSourceCredentials> {
      const { source, signal, requestedBy, connectionToken } = input
      const { owner, repo, path } = repository(source.url)
      const access = parseAccess(source)

      let selector: ConnectorConnectionSelector
      if (ownerMode === "project") {
        selector = { owner: { type: "project" }, slot }
      } else if (requestedBy?.type === "user") {
        selector = { owner: { type: "user", id: requestedBy.id }, slot }
      } else if (fallback) {
        return fallback.authorize(input)
      } else {
        throw new Error(
          "[SixbGitHub] User GitHub authentication requires a run requested by a user."
        )
      }

      if (typeof connectionToken !== "function") {
        throw new Error(
          "[SixbGitHub] Sandbox OAuth requires a host with connector connection support."
        )
      }

      const { permissions, label } = ACCESS[access]
      const scopeToken = (accessToken: string) =>
        request(`/applications/${encodedClientId}/token/scoped`, {
          authorization: basicAuth,
          method: "POST",
          signal,
          body: {
            access_token: accessToken,
            target: owner,
            repositories: [repo],
            permissions,
          },
          failures: {
            401: "[SixbGitHub] GitHub rejected the OAuth client credentials.",
            403:
              "[SixbGitHub] Either the GitHub App is not installed on this repository or the " +
              "connected GitHub account cannot access it.",
            404:
              "[SixbGitHub] Connected GitHub token is no longer valid; reconnect the GitHub " +
              "account.",
            422:
              "[SixbGitHub] The GitHub App or connected account does not grant the permissions " +
              `this workspace needs (${label}).`,
          },
        })

      let parentToken = await connectionToken(connector, selector)
      let grant: unknown
      try {
        grant = await scopeToken(parentToken.accessToken)
      } catch (error) {
        // GitHub answers 404 on /token/scoped when the parent user token expired or was invalidated.
        if (!(error instanceof HttpStatusError) || error.status !== 404) throw error
        parentToken.invalidate()
        parentToken = await connectionToken(connector, selector)
        grant = await scopeToken(parentToken.accessToken)
      }

      if (
        !record(grant) ||
        typeof grant.token !== "string" ||
        !grant.token ||
        /[\r\n]/.test(grant.token)
      ) {
        throw new Error("[SixbGitHub] Scoped user token response is invalid.")
      }
      const token = grant.token
      let revoked = false
      const revoke = async () => {
        if (revoked) return
        // Revokes only this scoped child token, leaving the stored connection and refresh token intact.
        await request(`/applications/${encodedClientId}/token`, {
          authorization: basicAuth,
          method: "DELETE",
          body: { access_token: token },
          revokeStatuses: [204, 404],
        })
        revoked = true
      }

      if (grant.expires_at === null) {
        await revokeAfterFailure(revoke, "Scoped user token")
        throw new Error(
          "[SixbGitHub] Scoped user token must expire; enable expiring user authorization tokens on the GitHub App."
        )
      }

      const expiresAt = new Date(typeof grant.expires_at === "string" ? grant.expires_at : "")
      const installation = record(grant.installation) ? grant.installation : undefined
      const installationAccount =
        installation && record(installation.account) ? installation.account : undefined
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() + 60_000 ||
        !record(grant.app) ||
        grant.app.client_id !== clientId ||
        !installation ||
        installation.repository_selection !== "selected" ||
        !grantsExactly(installation.permissions, permissions) ||
        !installationAccount ||
        typeof installationAccount.login !== "string" ||
        installationAccount.login.toLowerCase() !== owner.toLowerCase() ||
        signal.aborted
      ) {
        await revokeAfterFailure(revoke, "Scoped user token")
        throw new Error(
          "[SixbGitHub] Scoped user token did not match the requested repository, permissions or lifetime."
        )
      }

      let identity: GitIdentity
      try {
        identity = userIdentity(grant.user)
      } catch (error) {
        await revokeAfterFailure(revoke, "Scoped user token")
        throw error
      }

      return {
        requests: gitRequests(path, token, access),
        env: guestEnv(identity, access),
        expiresAt,
        revoke,
      }
    },
  })
}

function parseAccess(source: SandboxSourceAuthInput["source"]): Access {
  const access = source.access ?? "read"
  if (source.type !== "git" || (access !== "read" && access !== "write")) {
    throw new Error("[SixbGitHub] Workspace source must use Git with read or write access.")
  }
  return access
}

function parseOAuthConnector(value: unknown): SandboxOAuthConnector {
  if (
    !record(value) ||
    value.kind !== "connector" ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !record(value.adapter) ||
    !record(value.adapter.authentication) ||
    value.adapter.authentication.type !== "oauth2"
  ) {
    throw new Error("[SixbGitHub] Sandbox OAuth requires a GitHub OAuth connector definition.")
  }
  return value as unknown as SandboxOAuthConnector
}

function parseClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("[SixbGitHub] OAuth client ID must be a non-empty identifier.")
  }
  return value
}

function parseClientSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new Error("[SixbGitHub] OAuth client secret must be a non-empty string.")
  }
  return value
}

function parseSlot(value: string | undefined): string {
  if (value === undefined) return "default"
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("[SixbGitHub] Connection slot must be a non-empty string.")
  }
  return value.trim()
}

function parseOwnerMode(value: "user" | "project" | undefined): "user" | "project" {
  if (value === undefined || value === "user" || value === "project") return value ?? "user"
  throw new Error('[SixbGitHub] Connection owner must be "user" or "project".')
}

function parseFallback(value: SandboxSourceAuth | undefined): SandboxSourceAuth | undefined {
  if (value === undefined) return undefined
  if (typeof value?.authorize !== "function") {
    throw new Error("[SixbGitHub] Sandbox fallback auth requires an authorize function.")
  }
  const authorize = value.authorize.bind(value)
  return Object.freeze({ authorize })
}

/**
 * The requests the host injects the token into: Git fetch, plus push and the whole API with write
 * access. GitHub limits the token to this repository and to the permissions above, so no list of
 * API endpoints is needed, whatever client the agent uses.
 */
function gitRequests(path: string, token: string, access: Access): SandboxRequestCredential[] {
  const headers = {
    Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  }
  const fetchRequests: SandboxRequestCredential[] = [
    { origin: "https://github.com", path: `${path}/info/refs`, method: "GET", headers },
    { origin: "https://github.com", path: `${path}/git-upload-pack`, method: "POST", headers },
  ]
  if (access === "read") return fetchRequests

  return [
    ...fetchRequests,
    { origin: "https://github.com", path: `${path}/git-receive-pack`, method: "POST", headers },
    {
      origin: API,
      path: { prefix: "/" },
      method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      headers: { Authorization: `Bearer ${token}` },
    },
  ]
}

/** The Git identity, plus the token placeholder GitHub clients need with write access. */
function guestEnv(identity: GitIdentity, access: Access): GitIdentity {
  if (access === "read") return { ...identity }

  return { ...identity, GH_TOKEN: TOKEN_PLACEHOLDER, GITHUB_TOKEN: TOKEN_PLACEHOLDER }
}

/** Revoke after a failure without masking it: the original error is the one to report. */
async function revokeAfterFailure(revoke: () => Promise<void>, label: string): Promise<void> {
  try {
    await revoke()
  } catch {
    console.error(`[SixbGitHub] ${label} revocation failed after an authorization error.`)
  }
}

function repository(value: string): { owner: string; repo: string; path: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[SixbGitHub] Workspace repository URL is invalid.")
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname)
  if (
    url.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !match[1] ||
    !match[2] ||
    [".", ".."].includes(match[2])
  ) {
    throw new Error(
      "[SixbGitHub] Workspace auth requires a credential-free https://github.com/owner/repo URL."
    )
  }
  return { owner: match[1], repo: match[2], path: url.pathname.replace(/\/$/, "") }
}

/**
 * Commits made in the sandbox are attributed to the App's bot account. The email carries the
 * bot's numeric id, so commits stay attributed to it after the App is renamed.
 */
async function botIdentity(appId: string, jwt: string, token: string): Promise<GitIdentity> {
  // Shared by every caller of the instance: bounded by the request timeout, not a run's signal.
  const app = await request("/app", { authorization: `Bearer ${jwt}`, method: "GET" })
  if (
    !record(app) ||
    app.id !== Number(appId) ||
    typeof app.slug !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(app.slug)
  ) {
    throw new Error("[SixbGitHub] App response is invalid.")
  }

  const login = `${app.slug}[bot]`
  const user = await request(`/users/${encodeURIComponent(login)}`, {
    authorization: `Bearer ${token}`,
    method: "GET",
  })
  if (
    !record(user) ||
    typeof user.login !== "string" ||
    user.login.toLowerCase() !== login.toLowerCase() ||
    user.type !== "Bot" ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0
  ) {
    throw new Error("[SixbGitHub] App bot user response is invalid.")
  }

  const email = `${user.id}+${user.login}@users.noreply.github.com`
  return {
    GIT_AUTHOR_NAME: user.login,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: user.login,
    GIT_COMMITTER_EMAIL: email,
  }
}

/**
 * Commits made in the sandbox are attributed to the connected GitHub user, using their numeric
 * noreply address so commits link to their GitHub profile without exposing a private email.
 */
function userIdentity(user: unknown): GitIdentity {
  if (
    !record(user) ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(user.login) ||
    user.type !== "User" ||
    !Number.isSafeInteger(user.id) ||
    Number(user.id) <= 0
  ) {
    throw new Error("[SixbGitHub] Connected GitHub user response is invalid.")
  }

  const displayName =
    typeof user.name === "string" ? user.name.replace(/[\x00-\x1f\x7f<>]/g, "").trim() : ""
  const name = displayName || user.login
  const email = `${user.id}+${user.login}@users.noreply.github.com`
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  }
}

/** Every requested permission at its level, nothing else beyond the implicit metadata read. */
function grantsExactly(value: unknown, requested: Readonly<Record<string, string>>): boolean {
  if (!record(value)) return false

  return (
    Object.entries(requested).every(([name, level]) => value[name] === level) &&
    Object.entries(value).every(
      ([name, level]) => Object.hasOwn(requested, name) || (name === "metadata" && level === "read")
    )
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

interface ApiRequest {
  readonly authorization: string
  readonly method: "GET" | "POST" | "DELETE"
  readonly signal?: AbortSignal
  readonly body?: unknown
  /** Statuses treated as idempotent success on DELETE. */
  readonly revokeStatuses?: readonly number[]
  /** Actionable messages for statuses GitHub documents; never the response body. */
  readonly failures?: Readonly<Record<number, string>>
}

async function request(
  path: string,
  { authorization, method, signal, body, revokeStatuses = [204], failures = {} }: ApiRequest
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      method,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Authorization: authorization,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Error("[SixbGitHub] Workspace authentication request failed.")
  }
  if (method === "DELETE" && revokeStatuses.includes(response.status)) return
  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      failures[response.status] ??
        `[SixbGitHub] Workspace authentication failed (HTTP ${response.status}).`
    )
  }
  try {
    return await response.json()
  } catch {
    throw new Error("[SixbGitHub] Workspace authentication response is invalid.")
  }
}
