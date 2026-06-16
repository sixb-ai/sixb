import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { renderCustomAppRuntimeScript } from "./runtime"
import type { PageRoute } from "./scanner"

/**
 * Generates `.sixb/generated/routes.ts` with static route imports. Pages are
 * eager on purpose: project-specific apps bundle small, and a single bundle
 * (one JS file, one render-blocking CSS file) means no Suspense gap or
 * late-arriving styles when navigating — matching how Atlas/Sentinel route.
 */
export async function generateRouteManifest(
  routes: PageRoute[],
  generatedDir: string
): Promise<string> {
  await mkdir(generatedDir, { recursive: true })

  const imports = routes
    .map((route, index) => {
      const rel = relativeTo(generatedDir, route.filePath)
      return `import Page${index} from ${JSON.stringify(rel)}`
    })
    .join("\n")

  const entries = routes
    .map((route, index) => `  { path: ${JSON.stringify(route.path)}, component: Page${index} },`)
    .join("\n")

  const content = `${imports}

export const routes = [
${entries}
]
`

  const outPath = join(generatedDir, "routes.ts")
  await writeFileIfChanged(outPath, content)
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
    /**
     * Stylesheet to import from the generated entry. `undefined` keeps the
     * legacy behavior (import `app/globals.css` when it exists); `null` skips
     * the import; a path imports that file (e.g. compiled Tailwind output).
     */
    stylesheetPath?: string | null
  } = {}
): Promise<{ htmlPath: string; mainPath: string }> {
  await mkdir(generatedDir, { recursive: true })

  const appDir = options.appDir ? resolve(projectRoot, options.appDir) : join(projectRoot, "app")
  const globalsCssPath = join(appDir, "globals.css")
  const layoutPath = join(appDir, "layout.tsx")
  const layoutRel = relativeTo(generatedDir, layoutPath)
  const hasLayout = await fileExists(layoutPath)
  const stylesheetPath =
    options.stylesheetPath !== undefined
      ? options.stylesheetPath
      : (await fileExists(globalsCssPath))
        ? globalsCssPath
        : null
  const globalsCssImport = stylesheetPath
    ? `import ${JSON.stringify(relativeTo(generatedDir, stylesheetPath))}\n`
    : ""
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
  const mainContent = `import React from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Routes, Route, matchPath, useNavigate } from "react-router-dom"
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

const RESERVED_PATH_PREFIXES = ["/api", "/auth", "/ws", "/docs"]

function isReservedPath(pathname: string) {
  return RESERVED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  )
}

// Makes plain same-origin <a href="/..."> clicks navigate client-side, so app
// authors get SPA navigation without remembering react-router's <Link>.
// Deliberately conservative: anything unusual falls through to the browser.
function InternalLinkInterceptor() {
  const navigate = useNavigate()

  React.useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a")
      if (!(anchor instanceof HTMLAnchorElement)) return
      if (anchor.target && anchor.target !== "_self") return
      if (anchor.hasAttribute("download")) return
      if (anchor.relList.contains("external")) return
      if (!anchor.getAttribute("href")) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      if (isReservedPath(url.pathname)) return
      // Only intercept destinations the app actually routes; anything else may
      // be a real server resource and keeps native navigation.
      if (!routes.some((route) => matchPath(route.path, url.pathname))) return
      // Same-document hash links keep native scroll behavior.
      if (
        url.hash &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return
      }

      event.preventDefault()
      navigate(url.pathname + url.search + url.hash)
    }

    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [navigate])

  return null
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <InternalLinkInterceptor />
        ${layoutWrapperStart}
          <Routes>
            {routes.map((route) => (
              <Route key={route.path} path={route.path} element={<route.component />} />
            ))}
          </Routes>
        ${layoutWrapperEnd}
      </BrowserRouter>
    </QueryClientProvider>
  )
}

if (canRenderApp) {
  createRoot(document.getElementById("root")!).render(<App />)
}
`

  const mainPath = join(generatedDir, "main.tsx")
  await writeFileIfChanged(mainPath, mainContent)

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
  await writeFileIfChanged(htmlPath, htmlContent)

  return { htmlPath, mainPath }
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, "utf-8")) === content) {
      return
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error
    }
  }

  await writeFile(path, content, "utf-8")
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "ENOENT"
  )
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
