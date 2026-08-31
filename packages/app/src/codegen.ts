import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { AuthSessionAudience } from "@sixb/core"
import { renderAppManifest } from "./manifest"
import { resolveAppMetadata } from "./metadata"
import { renderCustomAppRuntimeScript } from "./runtime"
import { type AppRouteLayout, type PageRoute, routePatternKey } from "./scanner"

export interface BuiltInRouteManifestEntry {
  readonly path: string
  readonly moduleSpecifier: string
  readonly exportName?: string
}

export interface GenerateRouteManifestOptions {
  readonly builtInRoutes?: readonly BuiltInRouteManifestEntry[]
  readonly layouts?: readonly AppRouteLayout[]
}

export const AUTH_EXPERIENCE_BOOTSTRAP_PLACEHOLDER = "__SIXB_AUTH_BOOTSTRAP__"

/**
 * Generates `.sixb/generated/routes.ts` with static page/layout imports. Modules are
 * eager on purpose: project-specific apps bundle small, and a single bundle
 * (one JS file, one render-blocking CSS file) means no Suspense gap or
 * late-arriving styles when navigating — matching how Atlas routes.
 */
export async function generateRouteManifest(
  routes: readonly PageRoute[],
  generatedDir: string,
  options: GenerateRouteManifestOptions = {}
): Promise<string> {
  await mkdir(generatedDir, { recursive: true })

  const pages = [...routes].sort(compareRouteModules)
  const pageImports = pages
    .map((route, index) => {
      const rel = relativeTo(generatedDir, route.filePath)
      return `import Page${index} from ${JSON.stringify(rel)}`
    })
    .join("\n")
  const projectRoutePatterns = new Set(pages.map((route) => routePatternKey(route.path)))
  const builtInRoutes = (options.builtInRoutes ?? []).filter(
    (route) => !projectRoutePatterns.has(routePatternKey(route.path))
  )
  const builtInImports = builtInRoutes
    .map((route, index) => {
      if (route.exportName) {
        return `import { ${route.exportName} as BuiltInPage${index} } from ${JSON.stringify(route.moduleSpecifier)}`
      }

      return `import BuiltInPage${index} from ${JSON.stringify(route.moduleSpecifier)}`
    })
    .join("\n")
  const routePatterns = [...pages, ...builtInRoutes].map((route) => routePatternKey(route.path))
  const layouts = [...(options.layouts ?? [])]
    .filter((layout) => {
      const layoutPattern = routePatternKey(layout.path)
      return routePatterns.some(
        (routePattern) =>
          routePattern === layoutPattern || routePattern.startsWith(`${layoutPattern}/`)
      )
    })
    .sort(compareRouteModules)
  const layoutImports = layouts
    .map((layout, index) => {
      const rel = relativeTo(generatedDir, layout.filePath)
      return `import Layout${index} from ${JSON.stringify(rel)}`
    })
    .join("\n")

  const tree = createRouteTree()
  for (const [index, layout] of layouts.entries()) {
    insertRouteLayout(tree, layout, `Layout${index}`)
  }
  for (const [index, route] of pages.entries()) {
    insertRoutePage(tree, route.path, `Page${index}`, route.relativePath)
  }
  for (const [index, route] of builtInRoutes.entries()) {
    insertRoutePage(
      tree,
      route.path,
      `BuiltInPage${index}`,
      `${route.moduleSpecifier} (${route.path})`
    )
  }

  const importEntries = [
    'import { createElement } from "react"',
    layouts.length > 0
      ? 'import { Outlet, type RouteObject } from "react-router-dom"'
      : 'import type { RouteObject } from "react-router-dom"',
    pageImports,
    builtInImports,
    layoutImports,
  ]
    .filter(Boolean)
    .join("\n")
  const routePaths = [
    ...pages.map((route) => route.path),
    ...builtInRoutes.map((route) => route.path),
  ]
  const content = `${importEntries}

export const routePaths = ${JSON.stringify(routePaths, null, 2)} as const

export const routes = [
${renderRootRouteObjects(tree)}
] satisfies RouteObject[]
`

  const outPath = join(generatedDir, "routes.ts")
  await writeFileIfChanged(outPath, content)
  return outPath
}

interface RouteTreePage {
  readonly componentName: string
  readonly source: string
}

interface RouteTreeLayout {
  readonly componentName: string
  readonly source: string
}

interface RouteTreeNode {
  readonly segment: string
  readonly children: Map<string, RouteTreeNode>
  page?: RouteTreePage
  layout?: RouteTreeLayout
}

function createRouteTree(segment = ""): RouteTreeNode {
  return { segment, children: new Map() }
}

function insertRouteLayout(
  root: RouteTreeNode,
  layout: AppRouteLayout,
  componentName: string
): void {
  if (layout.path === "/") {
    throw new Error(
      `[SixbCustomApp] Root layout ${layout.relativePath} must remain the global app wrapper.`
    )
  }
  const node = resolveRouteNode(root, layout.path, layout.relativePath)
  if (node.layout) {
    throw new Error(
      `[SixbCustomApp] Conflicting layouts '${node.layout.source}' and '${layout.relativePath}' own route '${layout.path}'.`
    )
  }
  node.layout = { componentName, source: layout.relativePath }
}

function insertRoutePage(
  root: RouteTreeNode,
  path: string,
  componentName: string,
  source: string
): void {
  const node = resolveRouteNode(root, path, source)
  if (node.page) {
    throw new Error(
      `[SixbCustomApp] Conflicting pages '${node.page.source}' and '${source}' match route '${path}'.`
    )
  }
  node.page = { componentName, source }
}

function resolveRouteNode(root: RouteTreeNode, path: string, source: string): RouteTreeNode {
  let node = root
  for (const segment of splitRoutePath(path)) {
    const key = segment.startsWith(":") ? ":" : segment.toLowerCase()
    const existing = node.children.get(key)
    if (existing) {
      if (
        existing.segment.startsWith(":") &&
        segment.startsWith(":") &&
        existing.segment !== segment
      ) {
        throw new Error(
          `[SixbCustomApp] Route '${source}' uses dynamic segment '${segment}', but '${existing.segment}' already owns the same route position. Use one parameter name consistently.`
        )
      }
      node = existing
      continue
    }

    const child = createRouteTree(segment)
    node.children.set(key, child)
    node = child
  }
  return node
}

function renderRootRouteObjects(root: RouteTreeNode): string {
  const lines: string[] = []
  if (root.page) {
    lines.push(`  { path: "/", element: createElement(${root.page.componentName}) },`)
  }
  for (const child of sortedRenderableChildren(root)) {
    lines.push(...renderRouteNode(child, 1))
  }
  return lines.join("\n")
}

function renderRouteNode(node: RouteTreeNode, depth: number): string[] {
  const indent = "  ".repeat(depth)
  const children = sortedRenderableChildren(node)
  if (!node.layout && node.page && children.length === 0) {
    return [
      `${indent}{ path: ${JSON.stringify(node.segment)}, element: createElement(${node.page.componentName}) },`,
    ]
  }

  const lines = [`${indent}{`, `${indent}  path: ${JSON.stringify(node.segment)},`]
  if (node.layout) {
    lines.push(
      `${indent}  element: createElement(${node.layout.componentName}, { children: createElement(Outlet) }),`
    )
  }
  lines.push(`${indent}  children: [`)
  if (node.page) {
    lines.push(`${indent}    { index: true, element: createElement(${node.page.componentName}) },`)
  }
  for (const child of children) {
    lines.push(...renderRouteNode(child, depth + 2))
  }
  lines.push(`${indent}  ],`, `${indent}},`)
  return lines
}

function sortedRenderableChildren(node: RouteTreeNode): RouteTreeNode[] {
  return [...node.children.values()].filter(hasPageDescendant).sort((a, b) => {
    const aDynamic = a.segment.startsWith(":")
    const bDynamic = b.segment.startsWith(":")
    if (aDynamic !== bDynamic) return aDynamic ? 1 : -1
    return compareText(a.segment, b.segment)
  })
}

function hasPageDescendant(node: RouteTreeNode): boolean {
  if (node.page) return true
  for (const child of node.children.values()) {
    if (hasPageDescendant(child)) return true
  }
  return false
}

function splitRoutePath(path: string): string[] {
  if (path === "/") return []
  if (!path.startsWith("/")) {
    throw new Error(`[SixbCustomApp] Route path '${path}' must start with '/'.`)
  }
  const segments = path.slice(1).split("/")
  if (segments.some((segment) => !segment)) {
    throw new Error(`[SixbCustomApp] Route path '${path}' contains an empty segment.`)
  }
  return segments
}

function compareRouteModules(
  a: Pick<AppRouteLayout, "path" | "relativePath">,
  b: Pick<AppRouteLayout, "path" | "relativePath">
): number {
  return compareText(a.path, b.path) || compareText(a.relativePath, b.relativePath)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Generates the optional browser entry served by the API for `/auth/*`. */
export async function generateAuthExperienceEntry(
  projectRoot: string,
  generatedDir: string,
  options: {
    readonly appDir?: string
    readonly publicDir?: string
    readonly stylesheetPath?: string | null
  } = {}
): Promise<{ readonly htmlPath: string; readonly mainPath: string } | null> {
  await mkdir(generatedDir, { recursive: true })

  const appDir = options.appDir ? resolve(projectRoot, options.appDir) : join(projectRoot, "app")
  const authPath = join(appDir, "auth.tsx")
  if (!(await fileExists(authPath))) {
    return null
  }

  const publicDir = options.publicDir
    ? resolve(projectRoot, options.publicDir)
    : join(appDir, "public")
  const layoutPath = join(appDir, "layout.tsx")
  const globalsCssPath = join(appDir, "globals.css")
  const metadata = await resolveAppMetadata({ layoutPath, publicDir })
  const stylesheetPath =
    options.stylesheetPath !== undefined
      ? options.stylesheetPath
      : (await fileExists(globalsCssPath))
        ? globalsCssPath
        : null
  const stylesheetImport = stylesheetPath
    ? `import ${JSON.stringify(relativeTo(generatedDir, stylesheetPath))}`
    : ""
  const authRel = relativeTo(generatedDir, authPath)

  const mainContent = `import React from "react"
import { createRoot } from "react-dom/client"
import type {
  AuthExperienceActions,
  AuthExperienceState,
} from "@sixb/app/auth"
import AuthExperience from ${JSON.stringify(authRel)}
${stylesheetImport}

interface AuthExperienceBootstrap {
  readonly state: AuthExperienceState
  readonly signInUrl: string
  readonly submission?: {
    readonly kind: "requestMagicLink" | "confirmSignIn"
    readonly action: string
    readonly fields: Readonly<Record<string, string>>
  }
}

const root = document.getElementById("root")
if (!root) {
  throw new Error("[SixbApp] Could not find the auth experience root element.")
}

const encodedBootstrap = root.dataset.sixbAuth
if (!encodedBootstrap) {
  throw new Error("[SixbApp] Auth experience bootstrap is missing.")
}

const bootstrap = decodeBootstrap(encodedBootstrap)
const actions: AuthExperienceActions = {
  requestMagicLink(email) {
    submit("requestMagicLink", { email })
  },
  confirmSignIn() {
    submit("confirmSignIn")
  },
  restartSignIn() {
    window.location.assign(bootstrap.signInUrl)
  },
}

function submit(
  kind: NonNullable<AuthExperienceBootstrap["submission"]>["kind"],
  additionalFields: Readonly<Record<string, string>> = {}
): void {
  const submission = bootstrap.submission
  if (!submission || submission.kind !== kind) {
    throw new Error("[SixbApp] Auth action '" + kind + "' is not available in this state.")
  }

  const form = document.createElement("form")
  form.method = "post"
  form.action = submission.action
  form.hidden = true
  for (const [name, value] of Object.entries({ ...submission.fields, ...additionalFields })) {
    const input = document.createElement("input")
    input.type = "hidden"
    input.name = name
    input.value = value
    form.append(input)
  }
  document.body.append(form)
  form.submit()
}

function decodeBootstrap(value: string): AuthExperienceBootstrap {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as AuthExperienceBootstrap
}

createRoot(root).render(<AuthExperience state={bootstrap.state} actions={actions} />)
`

  const mainPath = join(generatedDir, "auth-main.tsx")
  await writeFileIfChanged(mainPath, mainContent)

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
${renderAuthMetadataHead(metadata)}
    <style>
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; min-height: 100%; }
      body, #root { min-height: 100vh; min-height: 100dvh; }
    </style>
  </head>
  <body>
    <div id="root" data-sixb-auth="${AUTH_EXPERIENCE_BOOTSTRAP_PLACEHOLDER}"></div>
    <script type="module" src="./auth-main.tsx"></script>
  </body>
</html>
`
  const htmlPath = join(generatedDir, "auth-index.html")
  await writeFileIfChanged(htmlPath, htmlContent)
  return { htmlPath, mainPath }
}

/**
 * Generates the app entry files:
 * - `.sixb/generated/index.html` — HTML shell
 * - `.sixb/generated/main.tsx` — React entry with BrowserRouter
 * - `.sixb/generated/app.webmanifest` — installable app identity
 */
export async function generateAppEntry(
  projectRoot: string,
  generatedDir: string,
  options: {
    apiBaseUrl?: string
    audience?: AuthSessionAudience
    authEnabled?: boolean
    appDir?: string
    publicDir?: string
    /**
     * Stylesheet to import from the generated entry. `undefined` auto-detects
     * `app/globals.css` and imports it when it exists; `null` skips the import;
     * a path imports that file (e.g. compiled Tailwind output).
     */
    stylesheetPath?: string | null
    /** Framework-owned stylesheets imported before the app stylesheet. */
    frameworkStylesheetPaths?: readonly string[]
  } = {}
): Promise<{ htmlPath: string; mainPath: string; manifestPath: string }> {
  await mkdir(generatedDir, { recursive: true })

  const appDir = options.appDir ? resolve(projectRoot, options.appDir) : join(projectRoot, "app")
  const publicDir = options.publicDir
    ? resolve(projectRoot, options.publicDir)
    : join(appDir, "public")
  const globalsCssPath = join(appDir, "globals.css")
  const layoutPath = join(appDir, "layout.tsx")
  const metadata = await resolveAppMetadata({ layoutPath, publicDir })
  const manifestPath = join(generatedDir, "app.webmanifest")
  await writeFileIfChanged(manifestPath, renderAppManifest(metadata))
  const layoutRel = relativeTo(generatedDir, layoutPath)
  const hasLayout = await fileExists(layoutPath)
  const stylesheetPath =
    options.stylesheetPath !== undefined
      ? options.stylesheetPath
      : (await fileExists(globalsCssPath))
        ? globalsCssPath
        : null
  const stylesheetPaths = [
    ...(options.frameworkStylesheetPaths ?? []),
    ...(stylesheetPath ? [stylesheetPath] : []),
  ]
  const globalsCssImport = stylesheetPaths
    .map((path) => `import ${JSON.stringify(relativeTo(generatedDir, path))}`)
    .join("\n")
  const layoutImport = hasLayout ? `import RootLayout from ${JSON.stringify(layoutRel)}\n` : ""
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
import { createRoot, type Root } from "react-dom/client"
import { signOut } from "@sixb/client"
import {
  BrowserRouter,
  matchPath,
  useLocation,
  useNavigate,
  useRoutes,
} from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  configureSixbBrowserClient,
  isSixbApiError,
  readSixbBrowserRuntimeConfig,
  requireSixbBrowserAuthSession,
} from "@sixb/client/browser"
import { routePaths, routes } from "./routes"
${globalsCssImport}
${layoutImport}

interface CustomAppHotData {
  root?: Root
  queryClient?: QueryClient
}

const runtimeConfig = readSixbBrowserRuntimeConfig({ audience: "app" })
const browserClient = configureSixbBrowserClient(runtimeConfig)

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    browserClient.dispose()
  })
}

const authSession = runtimeConfig.auth.enabled
  ? await requireSixbBrowserAuthSession(runtimeConfig, browserClient)
  : null
const applicationAccessDenied =
  authSession?.authenticated === true && !authSession.applicationAccess.allowed
const canRenderApp =
  !runtimeConfig.auth.enabled ||
  (authSession?.authenticated === true && authSession.applicationAccess.allowed)

const queryClient = getQueryClient()

function getRoot(): Root {
  const element = document.getElementById("root")
  if (!element) {
    throw new Error("[SixbApp] Could not find the root element.")
  }

  if (import.meta.hot) {
    const data = import.meta.hot.data as CustomAppHotData
    data.root ??= createRoot(element)
    return data.root
  }

  return createRoot(element)
}

function getQueryClient(): QueryClient {
  if (import.meta.hot) {
    const data = import.meta.hot.data as CustomAppHotData
    data.queryClient ??= createQueryClient()
    return data.queryClient
  }

  return createQueryClient()
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
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
      if (!routePaths.some((path) => matchPath(path, url.pathname))) return
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

// Shared presentational fallback used by the not-found view and the error
// boundary. Styled with @sixb/ui design tokens (var(--token)) so it adopts the
// app's theme when those tokens are loaded, but every token has a hardcoded
// fallback so it stays self-contained and readable when they are not. The
// background/foreground pair is always set together so text stays legible
// regardless of the surrounding app's background.
function AppFallback({
  title,
  detail,
  showReload = true,
  action,
}: {
  title: string
  detail: string
  showReload?: boolean
  action?: React.ReactNode
}) {
  return (
    <div
      role="alert"
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "2rem",
        textAlign: "center",
        fontFamily:
          "var(--font-sans, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)",
        background: "var(--background, #ffffff)",
        color: "var(--foreground, #1f2933)",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 600 }}>{title}</h1>
      <p style={{ margin: 0, maxWidth: "32rem", color: "var(--muted-foreground, #52606d)" }}>
        {detail}
      </p>
      <div style={{ display: "flex", gap: "0.75rem" }}>
        {action ?? (
          <>
            <a
              href="/"
              style={{
                padding: "0.5rem 1rem",
                borderRadius: "var(--radius, 0.5rem)",
                background: "var(--primary, #1f2933)",
                color: "var(--primary-foreground, #ffffff)",
                textDecoration: "none",
              }}
            >
              Go home
            </a>
            {showReload ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                style={{
                  padding: "0.5rem 1rem",
                  borderRadius: "var(--radius, 0.5rem)",
                  border: "1px solid var(--border, #cbd2d9)",
                  background: "transparent",
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                Reload
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function AccessDeniedView() {
  const [isSigningOut, setIsSigningOut] = React.useState(false)

  async function handleSignOut() {
    setIsSigningOut(true)
    try {
      await signOut({ throwOnError: true })
      window.location.reload()
    } catch {
      setIsSigningOut(false)
    }
  }

  return (
    <AppFallback
      title="Access required"
      detail="Your account is signed in, but it does not have permission to access this app."
      showReload={false}
      action={
        <button
          type="button"
          disabled={isSigningOut}
          onClick={handleSignOut}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: "var(--radius, 0.5rem)",
            border: "1px solid var(--border, #cbd2d9)",
            background: "transparent",
            color: "inherit",
            cursor: isSigningOut ? "default" : "pointer",
          }}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </button>
      }
    />
  )
}

// The not-found view. Rendered both for unmatched client routes (the catch-all
// route below) and for an expected 404 surfaced through a query. Apps will be
// able to override this via app/not-found.tsx.
function NotFoundView() {
  return (
    <AppFallback
      title="Not found"
      detail="The page or resource you requested does not exist."
      showReload={false}
    />
  )
}

// Last-resort safety net so an uncaught render throw (a 404 surfaced through a
// suspense/throwOnError query, a bug, a failed import) shows a fallback instead
// of a blank page and a console error. A missing object is an expected state,
// so a 404 reuses the not-found view rather than the generic crash screen.
// Apps will be able to override this via app/error.tsx.
function AppErrorFallback({ error }: { error: unknown }) {
  if (isSixbApiError(error) && error.status === 404) {
    return <NotFoundView />
  }
  return (
    <AppFallback
      title="Something went wrong"
      detail={error instanceof Error ? error.message : String(error)}
    />
  )
}

class AppErrorBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    console.error("[SixbApp] Uncaught render error:", error)
  }

  // Clear the error when the route changes so navigating away (or an in-app
  // link) recovers without a full reload.
  componentDidUpdate(prevProps: { resetKey: string }) {
    if (this.state.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error !== null) {
      return <AppErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  return (
    <AppErrorBoundary resetKey={location.pathname + location.search}>{children}</AppErrorBoundary>
  )
}

const appRoutes = [...routes, { path: "*", element: <NotFoundView /> }]

function AppRoutes() {
  return useRoutes(appRoutes)
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <InternalLinkInterceptor />
        <RoutedErrorBoundary>
          ${layoutWrapperStart}
            <AppRoutes />
          ${layoutWrapperEnd}
        </RoutedErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

if (canRenderApp) {
  getRoot().render(<App />)
} else if (applicationAccessDenied) {
  getRoot().render(<AccessDeniedView />)
}
`

  const mainPath = join(generatedDir, "main.tsx")
  await writeFileIfChanged(mainPath, mainContent)

  // Generate index.html with static identity and only structural reset rules.
  // Apps own visual styling through app/globals.css.
  const metadataHead = renderMetadataHead(metadata)
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
${metadataHead}
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
      body,
      #root {
        min-height: 100vh;
        min-height: 100dvh;
      }
      @media (display-mode: standalone) {
        html,
        body {
          overscroll-behavior: none;
        }
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

  return { htmlPath, mainPath, manifestPath }
}

function renderMetadataHead(metadata: Awaited<ReturnType<typeof resolveAppMetadata>>): string {
  const tags = [
    `    <title>${escapeHtmlText(metadata.title)}</title>`,
    ...(metadata.description
      ? [`    <meta name="description" content="${escapeHtmlAttribute(metadata.description)}" />`]
      : []),
    `    <meta name="theme-color" content="${escapeHtmlAttribute(metadata.themeColor)}" />`,
    '    <link rel="manifest" href="/app.webmanifest" />',
    ...(metadata.favicon
      ? [`    <link rel="icon" href="${escapeHtmlAttribute(metadata.favicon)}" />`]
      : []),
    ...(metadata.appleTouchIcon
      ? [`    <link rel="apple-touch-icon" href="${metadata.appleTouchIcon}" />`]
      : []),
  ]
  return tags.join("\n")
}

function renderAuthMetadataHead(metadata: Awaited<ReturnType<typeof resolveAppMetadata>>): string {
  const tags = [
    `    <title>${escapeHtmlText(metadata.title)}</title>`,
    ...(metadata.description
      ? [`    <meta name="description" content="${escapeHtmlAttribute(metadata.description)}" />`]
      : []),
    `    <meta name="theme-color" content="${escapeHtmlAttribute(metadata.themeColor)}" />`,
    ...(metadata.favicon && /^(?:https?:|data:)/.test(metadata.favicon)
      ? [`    <link rel="icon" href="${escapeHtmlAttribute(metadata.favicon)}" />`]
      : []),
  ]
  return tags.join("\n")
}

function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;")
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
