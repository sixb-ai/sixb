import { AgentContextProvider, useAgentContext } from "@sixb/agent-ui"
import { useAgentContextRegistry, useRegisteredAgentContext } from "@sixb/agent-ui/internal/context"
import { agentContext, agentContextIdentity } from "@sixb/core/agents/context"
import { createElement, type ReactNode, useEffect, useMemo, useRef } from "react"
import { matchPath, useLocation, useNavigate } from "react-router-dom"
import {
  type AppBrowserCommand,
  appBrowserControlPath,
  appBrowserControlSecretHeader,
} from "./browser-control-protocol"
import { appAgentNavigationState } from "./browser-navigation"

export interface AppAgentContextProviderProps {
  readonly routePaths: readonly string[]
  readonly browserControl?: boolean
  readonly children: ReactNode
}

/** Generated custom-app shell provider for automatic route context and optional dev control. */
export function AppAgentContextProvider(props: AppAgentContextProviderProps) {
  return createElement(AgentContextProvider, null, createElement(AppAgentContextRegistrar, props))
}

function AppAgentContextRegistrar({
  routePaths,
  browserControl = false,
  children,
}: AppAgentContextProviderProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const contextRegistry = useAgentContextRegistry()
  const registeredContext = useRegisteredAgentContext()
  // Intentionally memory-only: duplicated tabs can inherit sessionStorage from their opener, but
  // every mounted tab must be a distinct control target and conversation surface.
  const identity = useMemo(createBrowserIdentity, [])
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  useEffect(() => {
    if (!browserControl) return
    const controller = new AbortController()
    const currentRoutePaths = [...routePaths]

    void runBrowserControlLoop({
      identity,
      contextRegistry,
      routePaths: currentRoutePaths,
      navigate: (path) =>
        navigateRef.current(path, {
          state: appAgentNavigationState(),
        }),
      signal: controller.signal,
    }).catch((error) => {
      if (controller.signal.aborted) return
      console.error("[SixbApp] Browser control disconnected:", error)
    })

    return () => controller.abort()
  }, [browserControl, identity, routePaths, contextRegistry])

  const matchedRoute =
    routePaths.find((path) => matchPath({ path, end: true }, location.pathname)) ?? null
  const routeContext = agentContext.appState("sixb-custom-app-route", {
    label: document.title || "Custom app",
    description:
      "The exact current custom-app location, its matching route pattern, and every available route.",
    value: {
      location: {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      matchedRoute,
      routes: [...routePaths],
      browser: browserControl
        ? {
            sessionId: identity.sessionId,
            navigate: true,
            offeredContext: registeredContext
              .filter(
                (context) => context.kind !== "app-state" || context.id !== "sixb-custom-app-route"
              )
              .map(agentContextIdentity)
              .sort(),
          }
        : { navigate: false },
    },
    modelValue: {
      location: {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      matchedRoute,
      routes: [...routePaths],
      browser: { navigate: browserControl },
    },
  })
  useAgentContext(routeContext)
  return children
}

interface BrowserIdentity {
  readonly sessionId: string
  readonly secret: string
}

function createBrowserIdentity(): BrowserIdentity {
  return {
    sessionId: browserCredential(),
    secret: browserCredential() + browserCredential(),
  }
}

function browserCredential(): string {
  return crypto.randomUUID().replaceAll("-", "")
}

async function runBrowserControlLoop(input: {
  readonly identity: BrowserIdentity
  readonly routePaths: readonly string[]
  readonly navigate: (path: string) => void
  readonly signal: AbortSignal
  readonly contextRegistry: ReturnType<typeof useAgentContextRegistry>
}): Promise<void> {
  const headers = {
    "content-type": "application/json",
    [appBrowserControlSecretHeader]: input.identity.secret,
  }
  let retryDelayMs = 250
  while (!input.signal.aborted) {
    try {
      await runConnectedBrowserControlLoop(input, headers)
      retryDelayMs = 250
    } catch {
      if (input.signal.aborted) return
      await abortableDelay(retryDelayMs, input.signal)
      retryDelayMs = Math.min(retryDelayMs * 2, 5_000)
    }
  }
}

async function runConnectedBrowserControlLoop(
  input: {
    readonly identity: BrowserIdentity
    readonly routePaths: readonly string[]
    readonly navigate: (path: string) => void
    readonly signal: AbortSignal
    readonly contextRegistry: ReturnType<typeof useAgentContextRegistry>
  },
  headers: Record<string, string>
): Promise<void> {
  await requireBrowserResponse(
    await fetch(`${appBrowserControlPath}/register`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: input.identity.sessionId }),
      signal: input.signal,
    })
  )

  while (!input.signal.aborted) {
    const response = await fetch(
      `${appBrowserControlPath}/next?sessionId=${encodeURIComponent(input.identity.sessionId)}`,
      { headers, signal: input.signal }
    )
    if (response.status === 204) continue
    await requireBrowserResponse(response)
    const command = (await response.json()) as AppBrowserCommand
    const result = await browserCommandResult(command, input)
    await requireBrowserResponse(
      await fetch(`${appBrowserControlPath}/result`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          sessionId: input.identity.sessionId,
          commandId: command.id,
          ...result,
        }),
        signal: input.signal,
      })
    )
  }
}

async function browserCommandResult(
  command: AppBrowserCommand,
  input: {
    readonly routePaths: readonly string[]
    readonly navigate: (path: string) => void
    readonly contextRegistry: ReturnType<typeof useAgentContextRegistry>
    readonly signal: AbortSignal
  }
): Promise<
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }
> {
  try {
    const remaining = command.expiresAt - Date.now()
    if (remaining <= 0) throw new Error("The browser command has expired.")
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)])
    return { ok: true, value: await executeBrowserCommand(command, { ...input, signal }) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

async function executeBrowserCommand(
  command: AppBrowserCommand,
  input: {
    readonly routePaths: readonly string[]
    readonly navigate: (path: string) => void
    readonly contextRegistry: ReturnType<typeof useAgentContextRegistry>
    readonly signal: AbortSignal
  }
): Promise<unknown> {
  input.signal.throwIfAborted()
  const inspect = () => ({
    ...browserInspection(input.routePaths),
    contexts: input.contextRegistry.inspect(command.excludedContext),
  })
  if (command.kind === "inspect") return inspect()
  if (command.kind === "invoke") {
    await input.contextRegistry.invoke({
      registrationId: command.registrationId,
      command: command.command,
      input: command.input,
      excluded: command.excludedContext ?? [],
      signal: input.signal,
    })
    await nextBrowserPaint(input.signal)
    input.signal.throwIfAborted()
    return inspect()
  }
  if (command.kind === "navigate") {
    const url = new URL(command.path, window.location.href)
    if (url.origin !== window.location.origin) {
      throw new Error("Navigation is restricted to this custom app's origin.")
    }
    if (!input.routePaths.some((path) => matchPath({ path, end: true }, url.pathname))) {
      throw new Error(`No custom-app route matches '${url.pathname}'.`)
    }
    input.navigate(url.pathname + url.search + url.hash)
    await nextBrowserPaint(input.signal)
    input.signal.throwIfAborted()
    return inspect()
  }
}

function browserInspection(routePaths: readonly string[]) {
  const location = window.location
  return {
    title: document.title,
    url: location.href,
    location: {
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    },
    matchedRoute:
      routePaths.find((path) => matchPath({ path, end: true }, location.pathname)) ?? null,
    routes: [...routePaths],
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

async function nextBrowserPaint(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    let frame = 0
    const finish = () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    const abort = () => {
      finish()
      reject(signal.reason)
    }
    // Hidden tabs may suspend animation frames. Give React a task boundary there as well.
    const timer = setTimeout(finish, 100)
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(finish)
    })
    signal.addEventListener("abort", abort, { once: true })
  })
  signal.throwIfAborted()
}

async function requireBrowserResponse(response: Response): Promise<void> {
  if (response.ok) return
  let message = `Browser control request failed with ${response.status}.`
  try {
    const body = (await response.json()) as { readonly error?: unknown }
    if (typeof body.error === "string") message = body.error
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }
  throw new Error(message)
}
