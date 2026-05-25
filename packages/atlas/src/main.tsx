import {
  configureParioBrowserClient,
  type ParioBrowserRuntimeConfig,
  readParioBrowserRuntimeConfig,
  requireParioBrowserAuthSession,
} from "@pario/client/browser"
import { ThemeProvider } from "@pario/ui/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import "../.pario/ui.css"

let canRenderApp = false
let browserClient: ReturnType<typeof configureParioBrowserClient> | null = null

interface BuiltInUiHotData {
  root?: Root
  queryClient?: QueryClient
}

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.accept("./App", () => {
    renderApp()
  })
  import.meta.hot.on("bun:afterUpdate", () => {
    renderApp()
  })
  import.meta.hot.dispose(() => {
    browserClient?.dispose()
  })
}

void start()

async function start(): Promise<void> {
  await loadDevRuntimeConfig()

  const runtimeConfig = readParioBrowserRuntimeConfig({ audience: "atlas" })
  browserClient = configureParioBrowserClient(runtimeConfig)
  const authSession = runtimeConfig.auth.enabled
    ? await requireParioBrowserAuthSession(runtimeConfig, browserClient)
    : null
  canRenderApp = !runtimeConfig.auth.enabled || authSession?.authenticated === true

  if (!canRenderApp) {
    return
  }

  renderApp()
}

function renderApp(): void {
  if (!canRenderApp) {
    return
  }

  getRoot().render(
    <React.StrictMode>
      <QueryClientProvider client={getQueryClient()}>
        <ThemeProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </React.StrictMode>
  )
}

function getRoot(): Root {
  const element = document.getElementById("root")
  if (!element) {
    throw new Error("[ParioAtlas] Could not find the root element.")
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
  if (window.__PARIO_RUNTIME__) {
    return
  }

  let response: Response
  try {
    response = await fetch("/__pario/runtime.json", { cache: "no-store" })
  } catch {
    return
  }

  if (!response.ok) {
    return
  }

  const config: unknown = await response.json()
  if (isParioBrowserRuntimeConfig(config)) {
    window.__PARIO_RUNTIME__ = config
  }
}

function isParioBrowserRuntimeConfig(value: unknown): value is ParioBrowserRuntimeConfig {
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
