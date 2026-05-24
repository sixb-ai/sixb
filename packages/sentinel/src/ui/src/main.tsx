import {
  configureParioBrowserClient,
  readParioBrowserRuntimeConfig,
  requireParioBrowserAuthSession,
} from "@pario/client/browser"
import { ThemeProvider } from "@pario/ui/hooks"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import "../.pario/ui.css"

const runtimeConfig = readParioBrowserRuntimeConfig({ audience: "sentinel" })
const browserClient = configureParioBrowserClient(runtimeConfig)
const authSession = runtimeConfig.auth.enabled
  ? await requireParioBrowserAuthSession(runtimeConfig, browserClient)
  : null
const canRenderApp = !runtimeConfig.auth.enabled || authSession?.authenticated === true

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
})

if (canRenderApp) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </React.StrictMode>
  )
}
