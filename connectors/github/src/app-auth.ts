import { createPrivateKey, type KeyObject, sign } from "node:crypto"
import type { GitHubAppAuthOptions } from "./types/options"

const GITHUB_API_VERSION = "2022-11-28"
const REQUEST_TIMEOUT_MS = 30_000
const REFRESH_SKEW_MS = 60_000

export interface AppJwtSigner {
  readonly appId: string
  signJwt(): string
}

export function createAppJwtSigner(options: {
  readonly appId: string
  readonly privateKey: string
}): AppJwtSigner {
  const appId = parseAppId(options.appId)
  const key = parseAppPrivateKey(options.privateKey)
  return {
    appId,
    signJwt() {
      const now = Math.floor(Date.now() / 1000)
      const input = [
        Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
        Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString(
          "base64url"
        ),
      ].join(".")
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")}`
    },
  }
}

export function parseAppId(appId: unknown): string {
  if (typeof appId !== "string" || !/^[1-9][0-9]*$/.test(appId)) {
    throw new Error("[SixbGitHub] App ID must be a positive numeric string.")
  }
  return appId
}

/** Accept newlines escaped as a literal `\n`: a PEM key never contains a backslash. */
export function parseAppPrivateKey(value: unknown): KeyObject {
  try {
    const key = createPrivateKey(String(value).replaceAll("\\n", "\n"))
    if (key.asymmetricKeyType !== "rsa") throw new Error()
    return key
  } catch {
    throw new Error(
      "[SixbGitHub] App private key must be a valid RSA PEM key (escaped \\n newlines are accepted)."
    )
  }
}

export interface InstallationTokenHandle {
  readonly accessToken: string
  invalidate(): void
}

export interface AppInstallationTokenSource {
  get(signal?: AbortSignal): Promise<InstallationTokenHandle>
  revokeCurrent(): Promise<void>
}

interface CachedInstallationToken {
  readonly accessToken: string
  readonly expiresAtMs: number
  readonly revision: number
}

export function createAppInstallationTokenSource(
  options: GitHubAppAuthOptions,
  apiBaseUrl: URL
): AppInstallationTokenSource {
  const signer = createAppJwtSigner(options)
  const installationId = parseInstallationId(options.installationId)
  let current: CachedInstallationToken | undefined
  let inflight: Promise<CachedInstallationToken> | undefined
  let nextRevision = 0
  let rejectedRevision = -1

  const fetchFresh = async (signal?: AbortSignal): Promise<CachedInstallationToken> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const response = await fetch(
      new URL(`app/installations/${installationId}/access_tokens`, apiBaseUrl),
      {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${signer.signJwt()}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      }
    )
    if (!response.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(
        `[SixbGitHub] GitHub App installation token request failed with ${response.status}: ${body}`
      )
    }
    const payload: unknown = await response.json()
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as Record<string, unknown>).token !== "string" ||
      !(payload as Record<string, unknown>).token ||
      /[\r\n]/.test((payload as Record<string, unknown>).token as string) ||
      typeof (payload as Record<string, unknown>).expires_at !== "string"
    ) {
      throw new Error("[SixbGitHub] GitHub App installation token response is invalid.")
    }
    const accessToken = (payload as Record<string, unknown>).token as string
    const expiresAtMs = new Date(
      (payload as Record<string, unknown>).expires_at as string
    ).getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("[SixbGitHub] GitHub App installation token expiry is invalid.")
    }
    const entry: CachedInstallationToken = {
      accessToken,
      expiresAtMs,
      revision: ++nextRevision,
    }
    current = entry
    return entry
  }

  return {
    async get(signal?: AbortSignal): Promise<InstallationTokenHandle> {
      const reusable =
        current !== undefined &&
        current.revision > rejectedRevision &&
        current.expiresAtMs > Date.now() + REFRESH_SKEW_MS
      let resolved: CachedInstallationToken
      if (reusable && current) {
        resolved = current
      } else {
        inflight ??= fetchFresh(signal).finally(() => {
          inflight = undefined
        })
        resolved = await inflight
      }
      return {
        accessToken: resolved.accessToken,
        invalidate() {
          rejectedRevision = Math.max(rejectedRevision, resolved.revision)
        },
      }
    },
    async revokeCurrent(): Promise<void> {
      const active = current
      current = undefined
      if (!active) return
      await fetch(new URL("installation/token", apiBaseUrl), {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${active.accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      }).catch(() => undefined)
    },
  }
}

function parseInstallationId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("[SixbGitHub] App installation ID must be a positive integer.")
    }
    return String(value)
  }
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    return value
  }
  throw new Error("[SixbGitHub] App installation ID must be a positive integer.")
}
