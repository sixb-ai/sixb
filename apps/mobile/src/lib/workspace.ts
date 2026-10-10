import {
  createSixbClient,
  exchangeSixbSignInCode,
  getAuthSession,
  type SixbClient,
  type SixbSessionStore,
  type SixbSessionTokens,
  type SixbSignInLink,
  type SixbWebSocketFactory,
  signOutSixbSession,
  startSixbDeviceLogin,
} from "@sixb/client"
import * as SecureStore from "expo-secure-store"
import * as WebBrowser from "expo-web-browser"
import { Platform } from "react-native"
import { hostOf, normalizeWorkspaceAddress } from "./workspace-address"

/** A Sixb instance the app talks to. */
export interface Workspace {
  /** The instance's API origin, such as `https://acme-api.sixb.app`. */
  readonly baseUrl: string
  /** False for an instance that runs without sign-in, as the examples do in development. */
  readonly signIn: boolean
}

const WORKSPACE_KEY = "sixb.workspace"
const SESSION_KEY = "sixb.session"
const PROBE_TIMEOUT_MS = 10_000

// Shown beside the session on the instance's Sessions page.
const CLIENT_NAME = Platform.OS === "ios" ? "Sixb on iOS" : "Sixb on Android"

/** Check that `baseUrl` is a Sixb API and learn whether it needs sign-in. */
export async function probeWorkspace(baseUrl: string): Promise<Workspace> {
  const host = hostOf(baseUrl)
  let session: unknown
  try {
    const result = await getAuthSession({
      client: createSixbClient({ baseUrl }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    session = result.data
  } catch {
    throw new Error(`Couldn't reach ${host}. Check the address and your connection.`)
  }
  if (!isRecord(session) || typeof session.authenticated !== "boolean") {
    throw new Error(`${host} isn't a Sixb workspace.`)
  }
  return { baseUrl, signIn: session.authenticated || session.authEnabled === true }
}

/**
 * Sign this device in through the instance's approval page, in an in-app browser sheet. The sheet
 * may sit on "check your email" while a magic link is approved elsewhere; the poll finishes the
 * sign-in either way and closes it. Resolves false when the person closes the sheet first.
 */
export async function signInWithBrowser(workspace: Workspace): Promise<boolean> {
  const login = await startSixbDeviceLogin({ baseUrl: workspace.baseUrl, clientName: CLIENT_NAME })
  const closed = new AbortController()
  WebBrowser.openBrowserAsync(login.verificationUriComplete, { dismissButtonStyle: "cancel" })
    .then((result) => {
      if (result.type === WebBrowser.WebBrowserResultType.CANCEL) closed.abort()
    })
    .catch(() => closed.abort())

  try {
    await sessionStore.save(await login.complete({ signal: closed.signal }))
    return true
  } catch (error) {
    if (closed.signal.aborted) return false
    throw error
  } finally {
    // Rejects when the sheet is already gone, which is the state this wants.
    WebBrowser.dismissBrowser().catch(() => undefined)
  }
}

/** Sign in with a code from "Sign in on another device" in a signed-in browser, scanned or opened. */
export async function signInWithCode(link: SixbSignInLink): Promise<Workspace> {
  const baseUrl = normalizeWorkspaceAddress(link.baseUrl)
  const tokens = await exchangeSixbSignInCode({ baseUrl, code: link.code, clientName: CLIENT_NAME })
  await sessionStore.save(tokens)
  return { baseUrl, signIn: true }
}

/** Revoke the session on the instance, then forget it and the workspace on this device. */
export async function signOut(workspace: Workspace): Promise<void> {
  if (workspace.signIn) {
    try {
      await signOutSixbSession({ baseUrl: workspace.baseUrl, store: sessionStore })
    } catch (error) {
      // Leaving must work offline; the session then ends at its idle timeout.
      console.warn("[SixbMobile] Sign-out did not reach the workspace.", error)
    }
  }
  await sessionStore.clear()
  await SecureStore.deleteItemAsync(WORKSPACE_KEY)
}

export function createWorkspaceClient(
  workspace: Workspace,
  onSessionEnded: () => void
): SixbClient {
  return createSixbClient({
    baseUrl: workspace.baseUrl,
    auth: workspace.signIn
      ? { kind: "session", store: sessionStore, onSessionEnded }
      : { kind: "none" },
    webSocket: openWebSocket,
  })
}

type NativeWebSocketConstructor = new (
  url: string,
  protocols: string[] | null,
  options?: { readonly headers: Record<string, string> }
) => WebSocket

// React Native's WebSocket takes headers in a third argument, after the subprotocols. The session's
// access token reaches the agent stream this way.
const openWebSocket: SixbWebSocketFactory = (url, { protocols, headers }) =>
  new (WebSocket as unknown as NativeWebSocketConstructor)(
    url,
    protocols ? [...protocols] : null,
    headers ? { headers: { ...headers } } : undefined
  )

export async function loadWorkspace(): Promise<Workspace | null> {
  const stored = parseJson(await SecureStore.getItemAsync(WORKSPACE_KEY))
  if (!isRecord(stored)) return null
  if (typeof stored.baseUrl !== "string" || typeof stored.signIn !== "boolean") return null
  return { baseUrl: stored.baseUrl, signIn: stored.signIn }
}

export async function saveWorkspace(workspace: Workspace): Promise<void> {
  await SecureStore.setItemAsync(WORKSPACE_KEY, JSON.stringify(workspace))
}

// The session fetch reads the tokens before every request, so keep them in memory after the first
// read from the keychain.
let cachedTokens: SixbSessionTokens | null | undefined

/** The workspace session's tokens, in the device's secure storage. */
export const sessionStore: SixbSessionStore = {
  async load() {
    if (cachedTokens === undefined) {
      cachedTokens = parseTokens(parseJson(await SecureStore.getItemAsync(SESSION_KEY)))
    }
    return cachedTokens
  },
  async save(tokens) {
    cachedTokens = tokens
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(tokens))
  },
  async clear() {
    cachedTokens = null
    await SecureStore.deleteItemAsync(SESSION_KEY)
  },
}

function parseTokens(value: unknown): SixbSessionTokens | null {
  if (!isRecord(value)) return null
  const { accessToken, refreshToken, accessExpiresAt } = value
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") return null
  if (typeof accessExpiresAt !== "string") return null
  return { accessToken, refreshToken, accessExpiresAt }
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
