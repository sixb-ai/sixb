import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type { AuthSessionAudience } from "@sixb/core"
import { renderAppManifest } from "./manifest"
import { resolveAppMetadata } from "./metadata"
import { renderCustomAppRuntimeScript } from "./runtime"
import type { PageRoute } from "./scanner"

export interface BuiltInRouteManifestEntry {
  readonly path: string
  readonly moduleSpecifier: string
  readonly exportName?: string
}

export interface GenerateRouteManifestOptions {
  readonly builtInRoutes?: readonly BuiltInRouteManifestEntry[]
}

export const AUTH_EXPERIENCE_BOOTSTRAP_PLACEHOLDER = "__SIXB_AUTH_BOOTSTRAP__"

function assertNoReservedSharedRoutes(routes: readonly PageRoute[]): void {
  const reservedRoute = routes.find(
    (route) => route.path === "/shared" || route.path.startsWith("/shared/")
  )
  if (!reservedRoute) return

  throw new Error(
    `[SixbCustomApp] ${reservedRoute.relativePath} maps to the reserved ${JSON.stringify(reservedRoute.path)} route. Shared links reuse ordinary app pages; move this page outside app/shared/.`
  )
}

/**
 * Generates `.sixb/generated/routes.ts` with static route imports. Pages are
 * eager on purpose: project-specific apps bundle small, and a single bundle
 * (one JS file, one render-blocking CSS file) means no Suspense gap or
 * late-arriving styles when navigating — matching how Atlas routes.
 */
export async function generateRouteManifest(
  routes: PageRoute[],
  generatedDir: string,
  options: GenerateRouteManifestOptions = {}
): Promise<string> {
  assertNoReservedSharedRoutes(routes)
  await mkdir(generatedDir, { recursive: true })

  const imports = routes
    .map((route, index) => {
      const rel = relativeTo(generatedDir, route.filePath)
      return `import Page${index} from ${JSON.stringify(rel)}`
    })
    .join("\n")
  const builtInRoutes = options.builtInRoutes ?? []
  const builtInImports = builtInRoutes
    .map((route, index) => {
      if (route.exportName) {
        return `import { ${route.exportName} as BuiltInPage${index} } from ${JSON.stringify(route.moduleSpecifier)}`
      }

      return `import BuiltInPage${index} from ${JSON.stringify(route.moduleSpecifier)}`
    })
    .join("\n")

  const entries = routes
    .map((route, index) => `  { path: ${JSON.stringify(route.path)}, component: Page${index} },`)
    .join("\n")
  const builtInEntries = builtInRoutes
    .map(
      (route, index) => `  { path: ${JSON.stringify(route.path)}, component: BuiltInPage${index} },`
    )
    .join("\n")
  const routeEntries = [entries, builtInEntries].filter(Boolean).join("\n")
  const importEntries = [imports, builtInImports].filter(Boolean).join("\n")

  const content = `${importEntries}

export const routes = [
${routeEntries}
]
`

  const outPath = join(generatedDir, "routes.ts")
  await writeFileIfChanged(outPath, content)
  return outPath
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
 * - `.sixb/generated/index.html` — ordinary authenticated HTML shell
 * - `.sixb/generated/main.tsx` — ordinary authentication bootstrap
 * - `.sixb/generated/app-runtime.tsx` — shared route, layout, and query runtime
 * - `.sixb/generated/shared-index.html` — isolated shared-link HTML shell
 * - `.sixb/generated/shared-main.tsx` — delegated-session bootstrap
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
): Promise<{
  htmlPath: string
  mainPath: string
  manifestPath: string
  runtimePath: string
  sharedHtmlPath: string
  sharedMainPath: string
}> {
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

  // Keep the authored route tree in one runtime. The normal entry imports it directly; the
  // shared entry imports it only after establishing a grant-bound session.
  const runtimeContent = `import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { signOut } from "@sixb/client"
import { BrowserRouter, Routes, Route, matchPath, useNavigate, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { isSixbApiError } from "@sixb/client/browser"
import { routes } from "./routes"
${globalsCssImport}
${layoutImport}

interface CustomAppHotData {
  root?: Root
  queryClient?: QueryClient
}

export interface StartAppOptions {
  readonly basename?: string
}

if (import.meta.hot) import.meta.hot.accept()

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

const RESERVED_PATH_PREFIXES = ["/api", "/auth", "/ws", "/docs", "/shared"]

function isReservedPath(pathname: string) {
  return RESERVED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  )
}

function isSharedTransportPath(pathname: string): boolean {
  return pathname === "/shared" || pathname.startsWith("/shared/")
}

function primaryNavigationAnchor(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented) return null
  if (event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null

  const target = event.target
  if (!(target instanceof Element)) return null
  const anchor = target.closest("a")
  if (!(anchor instanceof HTMLAnchorElement)) return null
  if (anchor.target && anchor.target !== "_self") return null
  if (anchor.hasAttribute("download")) return null
  if (anchor.relList.contains("external")) return null
  if (!anchor.getAttribute("href")) return null
  return anchor
}

// A React Router <Link> mutates the current document before effects can reload it. Capture shared
// transport clicks first so an OIDC document never acquires a bearer fragment.
function SharedDocumentLinkInterceptor({ basename }: { readonly basename?: string }) {
  React.useLayoutEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = primaryNavigationAnchor(event)
      if (!anchor) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const appPath = pathInsideApp(url.pathname, basename)
      if (!isSharedTransportPath(appPath)) return

      // React Router prefixes an absolute <Link to="/shared/..."> with the current basename.
      // Rebuild the transport URL from the path inside the app so switching grants does not nest
      // the new link beneath /shared/:currentGrantId.
      const documentUrl = new URL(appPath + url.search + url.hash, url.origin)

      event.preventDefault()
      event.stopImmediatePropagation()
      window.location.assign(documentUrl.href)
    }

    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [basename])

  return null
}

// Makes plain same-origin <a href="/..."> clicks navigate client-side, so app
// authors get SPA navigation without remembering react-router's <Link>.
// Deliberately conservative: anything unusual falls through to the browser.
function InternalLinkInterceptor({ basename }: { readonly basename?: string }) {
  const navigate = useNavigate()

  React.useEffect(() => {
    function onClick(event: MouseEvent) {
      const anchor = primaryNavigationAnchor(event)
      if (!anchor) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const appPath = pathInsideApp(url.pathname, basename)
      if (isReservedPath(appPath)) return
      // Only intercept destinations the app actually routes; anything else may
      // be a real server resource and keeps native navigation.
      if (!routes.some((route) => matchPath(route.path, appPath))) return
      // Same-document hash links keep native scroll behavior.
      if (
        url.hash &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return
      }

      event.preventDefault()
      navigate(appPath + url.search + url.hash)
    }

    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [basename, navigate])

  return null
}

function pathInsideApp(pathname: string, basename: string | undefined): string {
  if (
    basename &&
    (pathname === basename || pathname.startsWith(basename.endsWith("/") ? basename : basename + "/"))
  ) {
    return pathname.slice(basename.length) || "/"
  }
  return pathname
}

// Programmatic React Router navigation cannot be blocked by BrowserRouter. Gate the ordinary page
// tree while forcing the new document so no route can run under the previous OIDC authority.
function SharedDocumentBoundary({ children }: { readonly children: React.ReactNode }) {
  const location = useLocation()
  const crossingBoundary = isSharedTransportPath(location.pathname)

  React.useLayoutEffect(() => {
    if (crossingBoundary) window.location.reload()
  }, [crossingBoundary])

  return crossingBoundary ? null : children
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
function AppErrorFallback({
  error,
  hideErrorDetails,
}: {
  error: unknown
  hideErrorDetails: boolean
}) {
  if (isSixbApiError(error) && error.status === 404) {
    return <NotFoundView />
  }
  return (
    <AppFallback
      title="Something went wrong"
      detail={
        hideErrorDetails
          ? "This shared page could not be displayed."
          : error instanceof Error
            ? error.message
            : String(error)
      }
    />
  )
}

class AppErrorBoundary extends React.Component<
  { resetKey: string; hideErrorDetails: boolean; children: React.ReactNode },
  { error: unknown }
> {
  state: { error: unknown } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    if (this.props.hideErrorDetails) {
      console.error("[SixbApp] A shared page failed to render.")
    } else {
      console.error("[SixbApp] Uncaught render error:", error)
    }
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
      return (
        <AppErrorFallback
          error={this.state.error}
          hideErrorDetails={this.props.hideErrorDetails}
        />
      )
    }
    return this.props.children
  }
}

function RoutedErrorBoundary({
  children,
  hideErrorDetails,
}: {
  children: React.ReactNode
  hideErrorDetails: boolean
}) {
  const location = useLocation()
  return (
    <AppErrorBoundary
      resetKey={location.pathname + location.search}
      hideErrorDetails={hideErrorDetails}
    >
      {children}
    </AppErrorBoundary>
  )
}

function RoutedApp({ hideErrorDetails }: { readonly hideErrorDetails: boolean }) {
  return (
    <RoutedErrorBoundary hideErrorDetails={hideErrorDetails}>
      ${layoutWrapperStart}
        <Routes>
          {routes.map((route) => (
            <Route key={route.path} path={route.path} element={<route.component />} />
          ))}
          <Route path="*" element={<NotFoundView />} />
        </Routes>
      ${layoutWrapperEnd}
    </RoutedErrorBoundary>
  )
}

function App({ basename }: StartAppOptions) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={basename}>
        <SharedDocumentLinkInterceptor basename={basename} />
        <InternalLinkInterceptor basename={basename} />
        {basename ? (
          <RoutedApp hideErrorDetails />
        ) : (
          <SharedDocumentBoundary>
            <RoutedApp hideErrorDetails={false} />
          </SharedDocumentBoundary>
        )}
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export function startApp(options: StartAppOptions = {}) {
  getRoot().render(<App basename={options.basename} />)
}

export function renderAccessDenied() {
  getRoot().render(<AccessDeniedView />)
}
`

  const runtimePath = join(generatedDir, "app-runtime.tsx")
  await writeFileIfChanged(runtimePath, runtimeContent)

  // The normal entry owns only ambient application authentication. Its imported runtime is the
  // exact same module the shared bootstrap loads after establishing delegated authority.
  const mainContent = `import {
  configureSixbBrowserClient,
  readSixbBrowserRuntimeConfig,
  requireSixbBrowserAuthSession,
} from "@sixb/client/browser"
import { renderAccessDenied, startApp } from "./app-runtime"

const runtimeConfig = readSixbBrowserRuntimeConfig({ audience: "app" })
const browserClient = configureSixbBrowserClient(runtimeConfig)

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => browserClient.dispose())
}

const authSession = runtimeConfig.auth.enabled
  ? await requireSixbBrowserAuthSession(runtimeConfig, browserClient)
  : null
const applicationAccessDenied =
  authSession?.authenticated === true && !authSession.applicationAccess.allowed
const canRenderApp =
  !runtimeConfig.auth.enabled ||
  (authSession?.authenticated === true && authSession.applicationAccess.allowed)

if (canRenderApp) {
  startApp()
} else if (applicationAccessDenied) {
  renderAccessDenied()
}
`

  const mainPath = join(generatedDir, "main.tsx")
  await writeFileIfChanged(mainPath, mainContent)

  // This module contains framework bootstrap only. It must never statically import routes, the
  // authored layout, or any page: that graph is imported after the session is accepted.
  const sharedMainContent = `import {
  configureSixbSharedBrowserClient,
  isSixbApiError,
  readSixbBrowserRuntimeConfig,
  type SixbSharedBrowserClientController,
} from "@sixb/client/browser"

export interface SharedAppBootstrap {
  readonly basename: string
  readonly grantId: string
  readonly requestedPath: string
  readonly secret: string | null
}

export interface SharedAppStartOptions {
  readonly loadAppStyles?: () => Promise<void>
}

let activeController: SixbSharedBrowserClientController | null = null

if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    activeController?.dispose()
    activeController = null
  })
}

export function startSharedApp(
  bootstrap: SharedAppBootstrap,
  options: SharedAppStartOptions = {}
): void {
  if (!isValidBootstrap(bootstrap)) {
    renderSharedFallback("unavailable")
    return
  }
  const { basename, grantId } = bootstrap
  let loadAppStyles = options.loadAppStyles

  activeController?.dispose()
  let controller: SixbSharedBrowserClientController
  try {
    const runtimeConfig = readSixbBrowserRuntimeConfig({
      audience: "app",
      authEnabled: false,
    })
    controller = configureSixbSharedBrowserClient(runtimeConfig, {
      grantId,
    })
    activeController = controller
  } catch {
    renderSharedFallback("unavailable")
    return
  }

  let secret = bootstrap.secret
  let canonicalDestinationPath: string | null = null
  let appStylesLoaded = false
  let pending = false

  const open = async () => {
    if (pending) return
    pending = true
    renderSharedFallback("loading")

    try {
      const exchangedSecret = secret !== null
      const session = await controller.establish(secret)
      // Once a server session exists the one-time link credential must not survive a retry.
      secret = null
      if (exchangedSecret) canonicalDestinationPath = session.destinationPath
      // Keep the trusted destination pending until this document is canonical or a hard
      // navigation to it has started. Application code never imports under the caller's path.
      if (canonicalDestinationPath !== null) {
        try {
          if (!canonicalizeInitialDestination(basename, canonicalDestinationPath)) return
        } catch (error) {
          // Both same-document canonicalization and the hard-navigation fallback failed. Retire
          // the newly established session before showing a terminal error so a reload cannot
          // restore it under the caller-controlled path.
          await controller.signOut().catch(() => undefined)
          controller.dispose()
          if (activeController === controller) activeController = null
          throw error
        }
        canonicalDestinationPath = null
      }
      if (!appStylesLoaded) {
        await loadAppStyles?.()
        loadAppStyles = undefined
        appStylesLoaded = true
      }

      const { startApp } = await import("./app-runtime")
      startApp({ basename })
    } catch (error) {
      if (isRetryableSharedFailure(error)) {
        console.error("[SixbSharedApp] Shared access could not be opened; retry is available.")
        renderSharedFallback("retryable", () => void open())
      } else {
        renderSharedFallback("unavailable")
      }
    } finally {
      pending = false
    }
  }

  void open()
}

function isValidBootstrap(value: SharedAppBootstrap): boolean {
  return (
    typeof value.grantId === "string" &&
    value.basename === "/shared/" + encodeURIComponent(value.grantId) &&
    value.requestedPath.startsWith("/") &&
    (value.secret === null || typeof value.secret === "string")
  )
}

function canonicalizeInitialDestination(basename: string, destinationPath: string): boolean {
  const canonicalPath = basename + destinationPath
  if (
    window.location.pathname !== canonicalPath ||
    window.location.search !== "" ||
    window.location.hash !== ""
  ) {
    try {
      window.history.replaceState(window.history.state, "", canonicalPath)
    } catch {
      // Preserve the authority boundary even when a browser or embedding policy denies History
      // mutation: a fresh document at the trusted server destination is still safe.
      window.location.replace(canonicalPath)
      return false
    }
  }
  return true
}

function isRetryableSharedFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  return (
    isSixbApiError(error) &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  )
}

function renderSharedFallback(
  state: "loading" | "retryable" | "unavailable",
  retry?: () => void
): void {
  const root = document.getElementById("root")
  if (!root) return

  const main = document.createElement("main")
  main.setAttribute("role", state === "loading" ? "status" : "alert")
  main.style.cssText =
    "min-height:100dvh;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;gap:.75rem;padding:2rem;text-align:center;" +
    "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"

  const title = document.createElement("h1")
  title.style.cssText = "margin:0;font-size:1.5rem"
  title.textContent =
    state === "loading"
      ? "Opening shared access…"
      : state === "retryable"
        ? "Unable to open this link"
        : "Link unavailable"
  const detail = document.createElement("p")
  detail.style.cssText = "margin:0;max-width:32rem"
  detail.textContent =
    state === "loading"
      ? "Please wait while this link is verified."
      : state === "retryable"
        ? "A temporary problem occurred. Please try again."
        : "This shared link is invalid, expired, or no longer available."
  main.append(title, detail)

  if (retry) {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = "Try again"
    button.style.cssText =
      "margin-top:.25rem;padding:.625rem 1rem;border:1px solid currentColor;" +
      "border-radius:.375rem;background:transparent;color:inherit;cursor:pointer;font:inherit"
    button.addEventListener("click", retry, { once: true })
    main.append(button)
  }

  root.replaceChildren(main)
}
`

  const sharedMainPath = join(generatedDir, "shared-main.tsx")
  await writeFileIfChanged(sharedMainPath, sharedMainContent)

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

  const sharedRuntimeConfigScript = options.apiBaseUrl
    ? renderCustomAppRuntimeScript({
        api: { baseUrl: options.apiBaseUrl },
        auth: { audience: "app", enabled: false },
      })
    : ""
  const sharedHtmlContent = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="referrer" content="no-referrer" />
${renderSharedMetadataHead(metadata)}
    ${sharedRuntimeConfigScript}
    <style>
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; min-height: 100%; }
      body, #root { min-height: 100vh; min-height: 100dvh; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      function renderUnavailable() {
        const root = document.getElementById("root")
        if (!root) return
        const main = document.createElement("main")
        main.setAttribute("role", "alert")
        main.style.cssText =
          "min-height:100dvh;display:grid;place-items:center;padding:2rem;text-align:center;" +
          "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
        const message = document.createElement("p")
        message.textContent = "This shared link is invalid, expired, or no longer available."
        main.append(message)
        root.replaceChildren(main)
      }

      function consumeBootstrap() {
        const rawFragment = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash
        // Only the canonical 32-byte bearer belongs to the transport. Ordinary page anchors must
        // remain intact when an established shared session is reloaded.
        const secret = /^[A-Za-z0-9_-]{43}$/.test(rawFragment) ? rawFragment : null
        if (secret !== null) {
          try {
            window.history.replaceState(
              window.history.state,
              "",
              window.location.pathname + window.location.search
            )
          } catch {
            return null
          }
        }

        const match = /^\\/shared\\/([^/]+)(\\/.*)?$/.exec(window.location.pathname)
        if (!match) return null
        let grantId
        try {
          grantId = decodeURIComponent(match[1])
        } catch {
          return null
        }
        if (encodeURIComponent(grantId) !== match[1]) return null
        return {
          basename: "/shared/" + match[1],
          grantId,
          requestedPath: match[2] ?? "/",
          secret,
        }
      }

      async function bootstrapSharedApp() {
        const bootstrap = consumeBootstrap()
        if (!bootstrap) {
          renderUnavailable()
          return
        }

        try {
          const { startSharedApp } = await import("./shared-main.tsx")
          startSharedApp(bootstrap)
        } catch {
          console.error("[SixbSharedApp] Shared application bootstrap failed.")
          renderUnavailable()
        }
      }

      void bootstrapSharedApp()
    </script>
  </body>
</html>
`
  const sharedHtmlPath = join(generatedDir, "shared-index.html")
  await writeFileIfChanged(sharedHtmlPath, sharedHtmlContent)

  return {
    htmlPath,
    mainPath,
    manifestPath,
    runtimePath,
    sharedHtmlPath,
    sharedMainPath,
  }
}

function renderSharedMetadataHead(
  metadata: Awaited<ReturnType<typeof resolveAppMetadata>>
): string {
  return [
    `    <title>${escapeHtmlText(metadata.title)}</title>`,
    ...(metadata.description
      ? [`    <meta name="description" content="${escapeHtmlAttribute(metadata.description)}" />`]
      : []),
    `    <meta name="theme-color" content="${escapeHtmlAttribute(metadata.themeColor)}" />`,
  ].join("\n")
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
