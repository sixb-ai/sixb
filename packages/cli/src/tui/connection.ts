import { hostname } from "node:os"
import {
  createSixbClient,
  getAuthSession,
  getProjectInfo,
  getSixbSessionAccessToken,
  type SixbClient,
  type SixbSessionTokens,
  startSixbDeviceLogin,
} from "@sixb/client"
import { normalizeApiUrl } from "../lib/api-client"
import {
  profileSessionStore,
  type ResolvedProfile,
  resolveProfile,
  updateConfig,
} from "../lib/profiles"

/** A project the app talks to, as the person signed in to it. */
export interface Connection {
  readonly apiUrl: string
  readonly client: SixbClient
  readonly project: { readonly id: string; readonly timeZone: string; readonly locale: string }
  /** Who is signed in; absent where the project runs without sign-in. */
  readonly user?: { readonly id: string; readonly email: string; readonly name: string }
  /** The person's own credential, as an `Authorization` header, read fresh for each use. */
  authorization(): Promise<string>
}

/** Why the app cannot connect yet, and where it would. */
export interface SignedOut {
  readonly apiUrl: string
  readonly profile?: string
  readonly reason: "signed-out" | "session-ended" | "unreachable"
  readonly message?: string
}

/** Connect as the CLI's current profile, as every `sixb` command does. */
export async function connect(input: {
  readonly apiUrl?: string
  readonly profile?: string
  readonly token?: string
}): Promise<Connection | SignedOut> {
  let resolved: ResolvedProfile
  try {
    resolved = await resolveProfile(input)
  } catch (error) {
    return { apiUrl: input.apiUrl ?? "", reason: "session-ended", message: errorText(error) }
  }
  const profile = resolved.profile
  const viaSession = resolved.tokenSource === "session" && profile !== undefined
  const client = createSixbClient({
    baseUrl: resolved.apiUrl,
    auth: viaSession
      ? { kind: "session", store: profileSessionStore(profile) }
      : resolved.token
        ? { kind: "bearer", token: resolved.token }
        : { kind: "none" },
  })
  const authorization = viaSession
    ? async () => {
        const token = await getSixbSessionAccessToken({
          baseUrl: resolved.apiUrl,
          store: profileSessionStore(profile),
        })
        return token ? `Bearer ${token}` : ""
      }
    : async () => (resolved.token ? `Bearer ${resolved.token}` : "")

  try {
    const [project, session] = await Promise.all([
      getProjectInfo({ client, throwOnError: true }),
      getAuthSession({ client, throwOnError: true }),
    ])
    const signedIn = session.data.authenticated ? session.data.user : undefined
    if (!session.data.authenticated && session.data.authEnabled) {
      return {
        apiUrl: resolved.apiUrl,
        ...(profile === undefined ? {} : { profile }),
        reason: "signed-out",
      }
    }
    return {
      apiUrl: resolved.apiUrl,
      client,
      project: project.data,
      ...(signedIn
        ? {
            user: {
              id: signedIn.id,
              email: signedIn.email,
              name: signedIn.displayName ?? signedIn.email,
            },
          }
        : {}),
      authorization,
    }
  } catch (error) {
    const status = (error as { status?: unknown }).status
    return {
      apiUrl: resolved.apiUrl,
      ...(profile === undefined ? {} : { profile }),
      reason: status === 401 || status === 403 ? "signed-out" : "unreachable",
      message: errorText(error),
    }
  }
}

/** A sign-in in progress: show the code, open the page, then wait for the person to approve it. */
export interface PendingSignIn {
  readonly apiUrl: string
  readonly userCode: string
  readonly url: string
  complete(signal: AbortSignal): Promise<void>
}

/**
 * Sign this computer in to `apiUrl` with the device flow, as `sixb login` does, and keep the
 * session on a profile named after the project.
 */
export async function startSignIn(apiUrl: string): Promise<PendingSignIn> {
  const baseUrl = normalizeApiUrl(apiUrl)
  const login = await startSixbDeviceLogin({ baseUrl, clientName: `sixb on ${hostname()}` })
  return {
    apiUrl: baseUrl,
    userCode: login.userCode,
    url: login.verificationUriComplete,
    async complete(signal) {
      const session: SixbSessionTokens = await login.complete({ signal })
      const client = createSixbClient({
        baseUrl,
        auth: { kind: "bearer", token: session.accessToken },
      })
      const { data: project } = await getProjectInfo({ client, throwOnError: true })
      await updateConfig((config) => ({
        version: 1,
        currentProfile: project.id,
        profiles: {
          ...config.profiles,
          [project.id]: { apiUrl: baseUrl, projectId: project.id, session },
        },
      }))
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
