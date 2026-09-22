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

/** GitHub.com Git access through short-lived, repository-scoped installation tokens. */
export function githubApp(options: GitHubAppOptions): SandboxSourceAuth {
  const appId = options.appId
  if (typeof appId !== "string" || !/^[1-9][0-9]*$/.test(appId)) {
    throw new Error("[GitHub] App ID must be a positive numeric string.")
  }
  const key = (() => {
    try {
      const result = createPrivateKey(options.privateKey)
      if (result.asymmetricKeyType !== "rsa") throw new Error()
      return result
    } catch {
      throw new Error("[GitHub] App private key must be a valid RSA PEM key.")
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
  return Object.freeze({
    async authorize({
      source,
      signal,
    }: Parameters<SandboxSourceAuth["authorize"]>[0]): Promise<SandboxSourceCredentials> {
      const { owner, repo, path } = repository(source.url)
      const access = source.access ?? "read"
      if (source.type !== "git" || (access !== "read" && access !== "write")) {
        throw new Error("[GitHub] Workspace source must use Git with read or write access.")
      }
      const installation = await request(
        `/repos/${owner}/${repo}/installation`,
        jwt(),
        "GET",
        signal
      )
      if (
        !record(installation) ||
        !Number.isSafeInteger(installation.id) ||
        Number(installation.id) <= 0
      ) {
        throw new Error("[GitHub] Repository installation response is invalid.")
      }
      const grant = await request(
        `/app/installations/${installation.id}/access_tokens`,
        jwt(),
        "POST",
        signal,
        { repositories: [repo], permissions: { contents: access } }
      )
      if (
        !record(grant) ||
        typeof grant.token !== "string" ||
        !grant.token ||
        /[\r\n]/.test(grant.token)
      ) {
        throw new Error("[GitHub] Installation token response is invalid.")
      }
      const token = grant.token
      let revoked = false
      const revoke = async () => {
        if (revoked) return
        // Cleanup must remain possible after the run's signal was aborted.
        await request("/installation/token", token, "DELETE")
        revoked = true
      }
      const expiresAt = new Date(typeof grant.expires_at === "string" ? grant.expires_at : "")
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() + 60_000 ||
        !record(grant.permissions) ||
        grant.permissions.contents !== access ||
        Object.entries(grant.permissions).some(
          ([name, value]) => name !== "contents" && !(name === "metadata" && value === "read")
        ) ||
        !Array.isArray(grant.repositories) ||
        grant.repositories.length !== 1 ||
        !record(grant.repositories[0]) ||
        typeof grant.repositories[0].full_name !== "string" ||
        grant.repositories[0].full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ||
        signal.aborted
      ) {
        await revoke()
        throw new Error(
          "[GitHub] Installation token did not match the requested repository, permissions or lifetime."
        )
      }
      const headers = {
        Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      }
      const requests: SandboxRequestCredential[] = [
        { origin: "https://github.com", path: `${path}/info/refs`, method: "GET", headers },
        { origin: "https://github.com", path: `${path}/git-upload-pack`, method: "POST", headers },
      ]
      if (access === "write") {
        requests.push({
          origin: "https://github.com",
          path: `${path}/git-receive-pack`,
          method: "POST",
          headers,
        })
      }
      return { requests, expiresAt, revoke }
    },
  })
}

function repository(value: string): { owner: string; repo: string; path: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("[GitHub] Workspace repository URL is invalid.")
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
      "[GitHub] Workspace auth requires a credential-free https://github.com/owner/repo URL."
    )
  }
  return { owner: match[1], repo: match[2], path: url.pathname.replace(/\/$/, "") }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function request(
  path: string,
  token: string,
  method: "GET" | "POST" | "DELETE",
  signal?: AbortSignal,
  body?: unknown
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
    throw new Error("[GitHub] Workspace authentication request failed.")
  }
  // Revoking an already invalid token is successful cleanup.
  if (method === "DELETE" && (response.status === 204 || response.status === 401)) return
  if (!response.ok)
    throw new Error(`[GitHub] Workspace authentication failed (HTTP ${response.status}).`)
  try {
    return await response.json()
  } catch {
    throw new Error("[GitHub] Workspace authentication response is invalid.")
  }
}
