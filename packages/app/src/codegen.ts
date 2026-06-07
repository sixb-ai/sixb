import { access, mkdir, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { renderCustomAppRuntimeScript } from "./runtime"
import type { PageRoute } from "./scanner"

/**
 * Generates `.sixb/generated/routes.ts` with lazy-loaded route imports.
 */
export async function generateRouteManifest(
  routes: PageRoute[],
  generatedDir: string
): Promise<string> {
  await mkdir(generatedDir, { recursive: true })

  const imports = routes
    .map((route) => {
      const rel = relativeTo(generatedDir, route.filePath)
      return `  { path: ${JSON.stringify(route.path)}, component: lazy(() => import(${JSON.stringify(rel)})) },`
    })
    .join("\n")

  const content = `import { lazy } from "react"

export const routes = [
${imports}
]
`

  const outPath = join(generatedDir, "routes.ts")
  await writeFile(outPath, content, "utf-8")
  return outPath
}

/**
 * Generates the app entry files:
 * - `.sixb/generated/index.html` — HTML shell
 * - `.sixb/generated/main.tsx` — React entry with BrowserRouter
 */
export async function generateAppEntry(
  projectRoot: string,
  generatedDir: string,
  options: {
    apiBaseUrl?: string
    audience?: string
    authEnabled?: boolean
    appDir?: string
  } = {}
): Promise<{ htmlPath: string; mainPath: string }> {
  await mkdir(generatedDir, { recursive: true })

  const appDir = options.appDir ? resolve(projectRoot, options.appDir) : join(projectRoot, "app")
  const globalsCssPath = join(appDir, "globals.css")
  const layoutPath = join(appDir, "layout.tsx")
  const globalsCssRel = relativeTo(generatedDir, globalsCssPath)
  const layoutRel = relativeTo(generatedDir, layoutPath)
  const hasGlobalsCss = await fileExists(globalsCssPath)
  const hasLayout = await fileExists(layoutPath)
  const globalsCssImport = hasGlobalsCss ? `import ${JSON.stringify(globalsCssRel)}\n` : ""
  const layoutImport = hasLayout
    ? `import RootLayout, { metadata } from ${JSON.stringify(layoutRel)}\n`
    : ""
  const metadataSpread = hasLayout
    ? `...(typeof metadata === "object" && metadata ? metadata : {}),`
    : ""
  const layoutWrapperStart = hasLayout ? "<RootLayout>" : "<>"
  const layoutWrapperEnd = hasLayout ? "</RootLayout>" : "</>"
  const runtimeConfigScript = options.apiBaseUrl
    ? renderCustomAppRuntimeScript({
        api: { baseUrl: options.apiBaseUrl },
        auth: { audience: options.audience ?? "app", enabled: options.authEnabled ?? true },
      })
    : ""

  // Generate main.tsx
  const mainContent = `import React, { Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  configureSixbBrowserClient,
  readSixbBrowserRuntimeConfig,
  requireSixbBrowserAuthSession,
} from "@sixb/client/browser"
import { routes } from "./routes"
${globalsCssImport}
${layoutImport}

const runtimeConfig = readSixbBrowserRuntimeConfig({ audience: "app" })
const browserClient = configureSixbBrowserClient(runtimeConfig)
const authSession = runtimeConfig.auth.enabled
  ? await requireSixbBrowserAuthSession(runtimeConfig, browserClient)
  : null
const canRenderApp = !runtimeConfig.auth.enabled || authSession?.authenticated === true

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

const appMetadata = {
  title: "Sixb",
  description: "",
  favicon: "",
  ${metadataSpread}
}

function applyMetadata() {
  if (appMetadata.title) {
    document.title = appMetadata.title
  }

  if (appMetadata.description) {
    let description = document.querySelector('meta[name="description"]')
    if (!description) {
      description = document.createElement("meta")
      description.setAttribute("name", "description")
      document.head.append(description)
    }
    description.setAttribute("content", appMetadata.description)
  }

  if (appMetadata.favicon) {
    let icon = document.querySelector('link[rel="icon"]')
    if (!icon) {
      icon = document.createElement("link")
      icon.setAttribute("rel", "icon")
      document.head.append(icon)
    }
    icon.setAttribute("href", appMetadata.favicon)
  }
}

if (canRenderApp) {
  applyMetadata()
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={<div />}>
          ${layoutWrapperStart}
            <Routes>
              {routes.map((route) => (
                <Route key={route.path} path={route.path} element={<route.component />} />
              ))}
            </Routes>
          ${layoutWrapperEnd}
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

if (canRenderApp) {
  createRoot(document.getElementById("root")!).render(<App />)
}
`

  const mainPath = join(generatedDir, "main.tsx")
  await writeFile(mainPath, mainContent, "utf-8")

  // Generate index.html with only structural reset rules. Apps own visual
  // styling through app/globals.css.
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Sixb</title>
    ${runtimeConfigScript}
    <style>
      * {
        box-sizing: border-box;
      }
      html,
      body,
      #root {
        margin: 0;
        min-height: 100%;
      }
      body {
        min-height: 100vh;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`

  const htmlPath = join(generatedDir, "index.html")
  await writeFile(htmlPath, htmlContent, "utf-8")

  return { htmlPath, mainPath }
}

function relativeTo(from: string, to: string): string {
  let rel = relative(from, to)
  // Ensure it starts with ./ or ../
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
