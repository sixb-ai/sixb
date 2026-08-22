import { signOut } from "@sixb/client"
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
  const authSession = runtimeConfig.auth.enabled
    ? await requireSixbBrowserAuthSession(runtimeConfig, browserClient)
    : null
  canRenderApp =
    !runtimeConfig.auth.enabled ||
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
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold tracking-tight">Atlas access required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account is signed in, but it does not have permission to access Atlas.
        </p>
        <Button className="mt-6" variant="outline" disabled={isSigningOut} onClick={handleSignOut}>
          {isSigningOut ? "Signing out…" : "Sign out"}
        </Button>
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
