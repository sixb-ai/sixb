import { createPrivateKey, sign } from "node:crypto"
import type { SandboxSourceAuth, SandboxSourceCredentials } from "@sixb/core"
import type { SandboxRequestCredential } from "@sixb/core/sandboxes"

export interface GitHubAppOptions {
  readonly appId: string
  /** PEM-encoded RSA private key. Never supplied to a sandbox or resolver result. */
  readonly privateKey: string
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
 * What each source access may do. `permissions` is requested for the installation token and
 * checked in GitHub's answer; `label` names them when the App has not granted them.
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

/** GitHub.com Git access through short-lived, repository-scoped installation tokens. */
export function githubApp(options: GitHubAppOptions): SandboxSourceAuth {
  const appId = options.appId
  if (typeof appId !== "string" || !/^[1-9][0-9]*$/.test(appId)) {
    throw new Error("[SixbGitHub] App ID must be a positive numeric string.")
  }
  const key = (() => {
    try {
      const result = createPrivateKey(options.privateKey)
      if (result.asymmetricKeyType !== "rsa") throw new Error()
      return result
    } catch {
      throw new Error("[SixbGitHub] App private key must be a valid RSA PEM key.")
    }
  })()
  const jwt = () => {
    const now = Math.floor(Date.now() / 1000)
    const input = [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString(
        "base64url"
      ),
    ].join(".")
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`
  }

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
    async authorize({
      source,
      signal,
    }: Parameters<SandboxSourceAuth["authorize"]>[0]): Promise<SandboxSourceCredentials> {
      const { owner, repo, path } = repository(source.url)
      const access = source.access ?? "read"
      if (source.type !== "git" || (access !== "read" && access !== "write")) {
        throw new Error("[SixbGitHub] Workspace source must use Git with read or write access.")
      }
      const installation = await request(`/repos/${owner}/${repo}/installation`, {
        token: jwt(),
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
        token: jwt(),
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
        await request("/installation/token", { token, method: "DELETE" })
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
        await revokeAfterFailure(revoke)
        throw new Error(
          "[SixbGitHub] Installation token did not match the requested repository, permissions or lifetime."
        )
      }

      let identity: GitIdentity
      try {
        identity = await gitIdentity(token)
      } catch (error) {
        await revokeAfterFailure(revoke)
        throw error
      }

      // The shared lookup does not follow this run's signal: check it again before handing out
      // access that nobody would revoke.
      if (signal.aborted) {
        await revokeAfterFailure(revoke)
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

/** The bot's Git identity, plus the token placeholder GitHub clients need with write access. */
function guestEnv(identity: GitIdentity, access: Access): GitIdentity {
  if (access === "read") return { ...identity }

  return { ...identity, GH_TOKEN: TOKEN_PLACEHOLDER, GITHUB_TOKEN: TOKEN_PLACEHOLDER }
}

/** Revoke after a failure without masking it: the original error is the one to report. */
async function revokeAfterFailure(revoke: () => Promise<void>): Promise<void> {
  try {
    await revoke()
  } catch {
    console.error("[SixbGitHub] Installation token revocation failed after an authorization error.")
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
  const app = await request("/app", { token: jwt, method: "GET" })
  if (
    !record(app) ||
    app.id !== Number(appId) ||
    typeof app.slug !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(app.slug)
  ) {
    throw new Error("[SixbGitHub] App response is invalid.")
  }

  const login = `${app.slug}[bot]`
  const user = await request(`/users/${encodeURIComponent(login)}`, { token, method: "GET" })
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
  readonly token: string
  readonly method: "GET" | "POST" | "DELETE"
  readonly signal?: AbortSignal
  readonly body?: unknown
  /** Actionable messages for statuses GitHub documents; never the response body. */
  readonly failures?: Readonly<Record<number, string>>
}

async function request(
  path: string,
  { token, method, signal, body, failures = {} }: ApiRequest
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      method,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw new Error("[SixbGitHub] Workspace authentication request failed.")
  }
  // Revoking an already invalid token is successful cleanup.
  if (method === "DELETE" && (response.status === 204 || response.status === 401)) return
  if (!response.ok) {
    throw new Error(
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
