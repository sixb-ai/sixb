/** What the shell was built to open. Written into the app by `writeDesktopApp`. */
export interface ShellConfig {
  /** Shown in the title bar, and to the user approving this window's sign-in. */
  readonly name: string
  /** The app, such as `https://app.example.com/`. */
  readonly appUrl: string
  readonly apiOrigin: string
}

export interface NavigationState {
  /** Approval pages already opened, so a waiting page that reloads opens its browser tab once. */
  readonly openedCodes: Set<string>
  lastSignIn: { readonly url: string; readonly at: number } | null
}

export type NavigationStep =
  /** Send the window somewhere else instead. */
  | { readonly kind: "load"; readonly url: string }
  /** Hand a URL to the system browser. */
  | { readonly kind: "open-external"; readonly url: string }

// One sign-in redirect can be reported more than once (as it starts, and again if the server
// redirects to it). Answering each report would start a second sign-in request and orphan the first.
const SIGN_IN_REPEAT_WINDOW_MS = 2_000

export function createNavigationState(): NavigationState {
  return { openedCodes: new Set(), lastSignIn: null }
}

/**
 * Decides what the shell does about a navigation of its window.
 *
 * The window is a browser the user cannot finish a sign-in in: a magic link opens in their own
 * browser, and identity providers turn embedded ones away. So the app's ordinary sign-in redirect
 * becomes a request to be approved from the system browser, and the approval page opens there.
 */
export function nextNavigationStep(
  config: ShellConfig,
  state: NavigationState,
  navigatedTo: string,
  now: number = Date.now()
): NavigationStep | null {
  let url: URL
  try {
    url = new URL(navigatedTo)
  } catch {
    return null
  }
  if (url.origin !== new URL(config.apiOrigin).origin) return null

  if (url.pathname === "/auth/sign-in") {
    const last = state.lastSignIn
    if (last && last.url === url.href && now - last.at < SIGN_IN_REPEAT_WINDOW_MS) return null
    state.lastSignIn = { url: url.href, at: now }

    const waiting = new URL("/auth/sign-in/device", url.origin)
    const returnTo = url.searchParams.get("returnTo")
    if (returnTo) waiting.searchParams.set("returnTo", returnTo)
    waiting.searchParams.set("client", config.name)
    return { kind: "load", url: waiting.href }
  }

  if (url.pathname === "/auth/sign-in/device") {
    const userCode = url.searchParams.get("user_code")
    if (!userCode || state.openedCodes.has(userCode)) return null
    state.openedCodes.add(userCode)

    const approval = new URL("/auth/device", url.origin)
    approval.searchParams.set("user_code", userCode)
    return { kind: "open-external", url: approval.href }
  }

  return null
}

/** Only web addresses leave for the system browser; a page cannot make the shell launch programs. */
export function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === "https:" || protocol === "http:"
  } catch {
    return false
  }
}
