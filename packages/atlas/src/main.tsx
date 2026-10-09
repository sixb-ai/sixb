import { type GetAuthSessionResponse, signOut } from "@sixb/client"
import {
  configureSixbBrowserClient,
  readSixbBrowserRuntimeConfig,
  requireSixbBrowserAuthSession,
  type SixbBrowserRuntimeConfig,
} from "@sixb/client/browser"
import { SixbEventsProvider } from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { ThemeProvider } from "@sixb/ui/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import { preloadWorkspacePath } from "./pages/workspaceRoutes"
import "../.sixb/ui.css"

let canRenderApp = false
let browserClient: ReturnType<typeof configureSixbBrowserClient> | null = null

interface BuiltInUiHotData {
  root?: Root
  queryClient?: QueryClient
}

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    browserClient?.dispose()
  })
}

void start()

async function start(): Promise<void> {
  await loadDevRuntimeConfig()

  const runtimeConfig = readSixbBrowserRuntimeConfig({ audience: "atlas" })
  browserClient = configureSixbBrowserClient(runtimeConfig)
  preloadWorkspacePath(window.location.pathname)
  let authSession: GetAuthSessionResponse | null
  try {
    authSession = runtimeConfig.auth.enabled
      ? await requireSixbBrowserAuthSession(runtimeConfig, browserClient)
      : null
  } catch (error) {
    // Without the API's answer Atlas can neither render nor send the user to sign in.
    console.error("[SixbAtlas] Could not load the session from the API:", error)
    renderApiUnavailable(runtimeConfig.api.baseUrl)
    return
  }
  canRenderApp =
    !runtimeConfig.auth.enabled ||
    (authSession?.authenticated === false && authSession.authEnabled === false) ||
    (authSession?.authenticated === true && authSession.applicationAccess.allowed)

  if (canRenderApp) {
    renderApp()
    return
  }

  if (authSession?.authenticated === true && !authSession.applicationAccess.allowed) {
    renderAccessDenied()
  }
}

function renderAccessDenied(): void {
  getRoot().render(
    <React.StrictMode>
      <AtlasAccessDenied />
    </React.StrictMode>
  )
}

function renderApiUnavailable(apiBaseUrl: string): void {
  const detail =
    `Atlas could not load your session from ${apiBaseUrl}. ` +
    "Check that the API is running and allows this origin, then retry."
  getRoot().render(
    <React.StrictMode>
      <AtlasNotice title="Can't reach the Sixb API" detail={detail}>
        <Button className="mt-6" variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </AtlasNotice>
    </React.StrictMode>
  )
}

function AtlasAccessDenied() {
  const [isSigningOut, setIsSigningOut] = React.useState(false)

  const handleSignOut = async () => {
    setIsSigningOut(true)
    try {
      await signOut({ throwOnError: true })
      window.location.reload()
    } catch {
      setIsSigningOut(false)
    }
  }

  return (
    <AtlasNotice
      title="Atlas access required"
      detail="Your account is signed in, but it does not have permission to access Atlas."
    >
      <Button className="mt-6" variant="outline" disabled={isSigningOut} onClick={handleSignOut}>
        {isSigningOut ? "Signing out…" : "Sign out"}
      </Button>
    </AtlasNotice>
  )
}

/** A full-page message shown instead of Atlas when it cannot start for this user. */
function AtlasNotice({
  title,
  detail,
  children,
}: {
  title: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
        {children}
      </section>
    </main>
  )
}

function renderApp(): void {
  if (!canRenderApp) {
    return
  }

  getRoot().render(
    <React.StrictMode>
      <QueryClientProvider client={getQueryClient()}>
        <SixbEventsProvider>
          <ThemeProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ThemeProvider>
        </SixbEventsProvider>
      </QueryClientProvider>
    </React.StrictMode>
  )
}

function getRoot(): Root {
  const element = document.getElementById("root")
  if (!element) {
    throw new Error("[SixbAtlas] Could not find the root element.")
  }

  if (import.meta.hot) {
    const data = import.meta.hot.data as BuiltInUiHotData
    if (!data.root) {
      data.root = createRoot(element)
    }
    return data.root
  }

  return createRoot(element)
}

function getQueryClient(): QueryClient {
  if (import.meta.hot) {
    const data = import.meta.hot.data as BuiltInUiHotData
    if (!data.queryClient) {
      data.queryClient = createQueryClient()
    }
    return data.queryClient
  }

  return createQueryClient()
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        refetchOnWindowFocus: false,
      },
    },
  })
}

async function loadDevRuntimeConfig(): Promise<void> {
  if (window.__SIXB_RUNTIME__) {
    return
  }

  let response: Response
  try {
    response = await fetch("/__sixb/runtime.json", { cache: "no-store" })
  } catch {
    return
  }

  if (!response.ok) {
    return
  }

  const config: unknown = await response.json()
  if (isSixbBrowserRuntimeConfig(config)) {
    window.__SIXB_RUNTIME__ = config
    if (!document.querySelector("script[data-sixb-dev-reload]")) {
      const script = document.createElement("script")
      script.dataset.sixbDevReload = ""
      script.src = "/__sixb/dev-reload.js"
      document.head.append(script)
    }
  }
}

function isSixbBrowserRuntimeConfig(value: unknown): value is SixbBrowserRuntimeConfig {
  if (!isRecord(value) || !isRecord(value.api) || !isRecord(value.auth)) {
    return false
  }

  return (
    typeof value.api.baseUrl === "string" &&
    typeof value.auth.audience === "string" &&
    typeof value.auth.enabled === "boolean"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
