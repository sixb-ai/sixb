import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateAppEntry, generateRouteManifest } from "../src/codegen"

interface SharedAppFixture {
  readonly root: string
  readonly appDir: string
  readonly generatedDir: string
}

async function createFixture(): Promise<SharedAppFixture> {
  const root = await mkdtemp(join(tmpdir(), "sixb-shared-app-"))
  const appDir = join(root, "app")
  const generatedDir = join(root, ".sixb", "generated")
  await mkdir(join(appDir, "public"), { recursive: true })
  await writeFile(join(appDir, "globals.css"), "body { color: inherit; }\n")
  await writeFile(
    join(appDir, "layout.tsx"),
    [
      'export const metadata = { title: "Private workspace", favicon: "/favicon.svg" }',
      "export default function Layout({ children }) { return children }",
      "",
    ].join("\n")
  )
  await writeFile(join(appDir, "public", "favicon.svg"), "<svg></svg>\n")
  return { root, appDir, generatedDir }
}

describe("generated shared application bootstrap", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("scrubs only a canonical link secret before loading any shared code", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { sharedHtmlPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const shell = await readFile(sharedHtmlPath, "utf-8")

    // This is intentionally a source-order contract: the inline module cannot be imported into
    // Bun without executing its dynamic browser entry. Removing/moving the scrub makes one of
    // these monotonic positions or the explicit abort branch fail.
    const capture = shell.indexOf("const rawFragment = window.location.hash")
    const secretCheck = shell.indexOf("const secret = /^[A-Za-z0-9_-]{43}$/.test(rawFragment)")
    const scrub = shell.indexOf("window.history.replaceState(")
    const orchestration = shell.indexOf("async function bootstrapSharedApp()")
    const bootstrap = shell.indexOf("const bootstrap = consumeBootstrap()", orchestration)
    const sharedImport = shell.indexOf('await import("./shared-main.tsx")')

    expect(capture).toBeGreaterThan(-1)
    expect(secretCheck).toBeGreaterThan(capture)
    expect(scrub).toBeGreaterThan(secretCheck)
    expect(orchestration).toBeGreaterThan(scrub)
    expect(bootstrap).toBeGreaterThan(orchestration)
    expect(sharedImport).toBeGreaterThan(bootstrap)
    expect(shell).toContain("if (secret !== null) {")
    expect(shell).toContain("} catch {\n            return null\n          }")
    expect(shell).toContain("if (!bootstrap) {\n          renderUnavailable()\n          return")
    expect(shell).toContain("void bootstrapSharedApp()")
    expect(shell).not.toContain('<script type="module">')
    expect(shell).toContain("const match = /^\\/shared\\/([^/]+)(\\/.*)?$/")
    expect(shell).toContain('requestedPath: match[2] ?? "/"')
    expect(shell).not.toContain('src="./shared-main.tsx"')
    expect(shell).not.toContain('import("./app-runtime")')
    expect(shell).not.toContain("configureSixbSharedBrowserClient")
  })

  test("aborts the executable bootstrap when the fragment cannot be scrubbed", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { sharedHtmlPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const shell = await readFile(sharedHtmlPath, "utf-8")
    let sharedImports = 0

    await executeSharedShellBootstrap(shell, {
      replaceState() {
        throw new DOMException("history unavailable", "SecurityError")
      },
      async loadSharedMain() {
        sharedImports += 1
        return { startSharedApp() {} }
      },
    })

    expect(sharedImports).toBe(0)
  })

  test("executes the scrub before import and keeps the bearer local to the bootstrap", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { sharedHtmlPath } = await generateAppEntry(fixture.root, fixture.generatedDir)
    const shell = await readFile(sharedHtmlPath, "utf-8")
    const events: string[] = []
    let receivedBootstrap: unknown

    await executeSharedShellBootstrap(shell, {
      replaceState() {
        events.push("scrub")
      },
      async loadSharedMain() {
        events.push("import")
        return {
          startSharedApp(bootstrap) {
            events.push("start")
            receivedBootstrap = bootstrap
          },
        }
      },
    })

    expect(events).toEqual(["scrub", "import", "start"])
    expect(receivedBootstrap).toEqual({
      basename: "/shared/shr_1",
      grantId: "shr_1",
      requestedPath: "/reports/report-1",
      secret: "S".repeat(43),
    })
  })

  test("preserves ordinary anchors on restore and trusts the server destination after exchange", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { sharedHtmlPath, sharedMainPath } = await generateAppEntry(
      fixture.root,
      fixture.generatedDir
    )
    const shell = await readFile(sharedHtmlPath, "utf-8")
    const sharedMain = await readFile(sharedMainPath, "utf-8")

    // A #section fragment produces a null secret and is left on the URL. The controller then
    // restores the HttpOnly session through the same establish(null) path.
    expect(shell).toContain("const secret = /^[A-Za-z0-9_-]{43}$/.test(rawFragment)")
    expect(shell).toContain("if (secret !== null) {")
    expect(shell).not.toContain("if (window.location.hash) {")
    expect(sharedMain).toContain("const session = await controller.establish(secret)")

    // Only a successful one-time exchange replaces the caller-supplied destination. A restore
    // keeps its current suffix, search, and ordinary hash for normal page navigation/reloads.
    const establish = sharedMain.indexOf("const session = await controller.establish(secret)")
    const forgetSecret = sharedMain.indexOf("secret = null", establish)
    const rememberDestination = sharedMain.indexOf(
      "if (exchangedSecret) canonicalDestinationPath = session.destinationPath",
      forgetSecret
    )
    const canonicalize = sharedMain.indexOf(
      "if (!canonicalizeInitialDestination(basename, canonicalDestinationPath)) return",
      rememberDestination
    )
    const retireSession = sharedMain.indexOf(
      "await controller.signOut().catch(() => undefined)",
      canonicalize
    )
    const clearDestination = sharedMain.indexOf("canonicalDestinationPath = null", canonicalize)
    const loadStyles = sharedMain.indexOf("await loadAppStyles?.()", clearDestination)
    const importApp = sharedMain.indexOf('await import("./app-runtime")', loadStyles)

    // A successful exchange is never replayed: retries call establish(null). The destination is
    // kept pending across a failed second replaceState, so no app module can load under the
    // caller-controlled path before canonicalization eventually succeeds.
    expect(forgetSecret).toBeGreaterThan(establish)
    expect(rememberDestination).toBeGreaterThan(forgetSecret)
    expect(canonicalize).toBeGreaterThan(rememberDestination)
    // Regression proof: remove the fail-closed sign-out after a canonicalization failure and this
    // ordering contract fails. A reload must not restore the new session on the caller's path.
    expect(retireSession).toBeGreaterThan(canonicalize)
    expect(clearDestination).toBeGreaterThan(retireSession)
    expect(loadStyles).toBeGreaterThan(clearDestination)
    expect(importApp).toBeGreaterThan(loadStyles)
    expect(sharedMain).toContain("let canonicalDestinationPath: string | null = null")
    expect(sharedMain).toContain("if (canonicalDestinationPath !== null) {")
    expect(sharedMain).toContain("if (!appStylesLoaded) {")
    expect(sharedMain).toContain("loadAppStyles = undefined")
    const secretCapture = "let secret = bootstrap.secret"
    expect(
      sharedMain.slice(sharedMain.indexOf(secretCapture) + secretCapture.length)
    ).not.toContain("bootstrap.")
    expect(sharedMain).toContain("const canonicalPath = basename + destinationPath")
    expect(sharedMain).toContain('window.location.search !== ""')
    expect(sharedMain).toContain('window.location.hash !== ""')
    expect(sharedMain).toContain("window.location.replace(canonicalPath)")
    expect(sharedMain).toContain("return false")
    expect(sharedMain).toContain("if (activeController === controller) activeController = null")
  })

  test("establishes delegated authority before importing the ordinary app runtime", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { mainPath, runtimePath, sharedMainPath } = await generateAppEntry(
      fixture.root,
      fixture.generatedDir
    )
    const main = await readFile(mainPath, "utf-8")
    const runtime = await readFile(runtimePath, "utf-8")
    const sharedMain = await readFile(sharedMainPath, "utf-8")

    const configure = sharedMain.indexOf("configureSixbSharedBrowserClient(runtimeConfig")
    const establish = sharedMain.indexOf("await controller.establish(secret)")
    const appImport = sharedMain.indexOf('await import("./app-runtime")')
    const start = sharedMain.indexOf("startApp({ basename })")

    expect(configure).toBeGreaterThan(-1)
    expect(establish).toBeGreaterThan(configure)
    expect(appImport).toBeGreaterThan(establish)
    expect(start).toBeGreaterThan(appImport)
    expect(sharedMain).not.toContain('from "./app-runtime"')
    expect(sharedMain).not.toContain('from "./routes"')
    expect(sharedMain).not.toContain("RootLayout")
    expect(sharedMain).not.toContain("useSharedAccess")
    expect(sharedMain).toContain("readonly loadAppStyles?: () => Promise<void>")

    expect(main).toContain('from "./app-runtime"')
    expect(runtime).toContain('import { routes } from "./routes"')
    expect(runtime).toContain('import "../../app/globals.css"')
    expect(runtime).toContain('import RootLayout from "../../app/layout.tsx"')
    expect(runtime).toContain("<QueryClientProvider client={queryClient}>")
    expect(runtime).toContain("<BrowserRouter basename={basename}>")
    expect(runtime).toContain("startApp(options: StartAppOptions = {})")
  })

  test("keeps the shared transport in a distinct generic shell and document boundary", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)
    const { runtimePath, sharedHtmlPath, sharedMainPath } = await generateAppEntry(
      fixture.root,
      fixture.generatedDir,
      { apiBaseUrl: "https://api.example.test" }
    )
    const runtime = await readFile(runtimePath, "utf-8")
    const shell = await readFile(sharedHtmlPath, "utf-8")
    const sharedMain = await readFile(sharedMainPath, "utf-8")

    expect(shell).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />')
    expect(shell).toContain('<meta name="referrer" content="no-referrer" />')
    expect(shell).not.toContain('rel="manifest"')
    expect(shell).not.toContain('rel="icon"')
    expect(shell).not.toContain('rel="apple-touch-icon"')
    expect(shell).toContain('"baseUrl":"https://api.example.test"')
    expect(shell).toContain('"enabled":false')
    expect(shell).not.toContain("app.webmanifest")

    const genericMessage = "This shared link is invalid, expired, or no longer available."
    expect(shell).toContain(genericMessage)
    expect(sharedMain).toContain(genericMessage)
    expect(sharedMain).not.toContain("bootstrap.grantId +")
    expect(sharedMain).not.toContain("bootstrap.requestedPath +")
    expect(sharedMain).not.toContain('", error)')

    // Shared anchors are captured before React Router can put their fragment in the OIDC document;
    // programmatic navigation gates the page tree while forcing the document boundary.
    expect(runtime).toContain(
      'const RESERVED_PATH_PREFIXES = ["/api", "/auth", "/ws", "/docs", "/shared"]'
    )
    expect(runtime).toContain("if (isReservedPath(appPath)) return")
    expect(runtime).toContain("<SharedDocumentLinkInterceptor basename={basename} />")
    expect(runtime).toContain('document.addEventListener("click", onClick, true)')
    expect(runtime).toContain("event.stopImmediatePropagation()")
    expect(runtime).toContain(
      "const documentUrl = new URL(appPath + url.search + url.hash, url.origin)"
    )
    expect(runtime).toContain("window.location.assign(documentUrl.href)")
    expect(runtime).toContain("<SharedDocumentBoundary>")
    expect(runtime).toContain("React.useLayoutEffect")
    expect(runtime).toContain("return crossingBoundary ? null : children")
    expect(runtime).toContain("window.location.reload()")
    expect(runtime).toContain('? "This shared page could not be displayed."')
    expect(runtime).toContain("<RoutedApp hideErrorDetails />")
    expect(runtime).toContain('console.error("[SixbApp] A shared page failed to render.")')
  })

  test("rejects app/shared pages because shared links reuse ordinary pages", async () => {
    const fixture = await createFixture()
    roots.push(fixture.root)

    await expect(
      generateRouteManifest(
        [
          {
            path: "/shared/:grantId",
            filePath: join(fixture.appDir, "shared", "[grantId]", "page.tsx"),
            relativePath: "shared/[grantId]/page.tsx",
          },
        ],
        fixture.generatedDir
      )
    ).rejects.toThrow('shared/[grantId]/page.tsx maps to the reserved "/shared/:grantId" route')

    await expect(
      generateRouteManifest(
        [
          {
            path: "/shares",
            filePath: join(fixture.appDir, "shares", "page.tsx"),
            relativePath: "shares/page.tsx",
          },
        ],
        fixture.generatedDir
      )
    ).resolves.toBe(join(fixture.generatedDir, "routes.ts"))
  })
})

interface SharedShellHarnessOptions {
  readonly replaceState: () => void
  readonly loadSharedMain: () => Promise<{
    readonly startSharedApp: (bootstrap: unknown) => void
  }>
}

async function executeSharedShellBootstrap(
  shell: string,
  options: SharedShellHarnessOptions
): Promise<void> {
  const scripts = [...shell.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  const source = scripts.at(-1)?.[1]
  if (!source) throw new Error("Expected the generated shared bootstrap script.")

  const rewrittenImport = source.replace(
    'const { startSharedApp } = await import("./shared-main.tsx")',
    "const { startSharedApp } = await loadSharedMain()"
  )
  if (rewrittenImport === source) {
    throw new Error("Expected to instrument the generated shared import.")
  }
  const executableSource = rewrittenImport.replace(
    "void bootstrapSharedApp()",
    "return bootstrapSharedApp()"
  )
  if (executableSource === rewrittenImport) {
    throw new Error("Expected to instrument the generated bootstrap invocation.")
  }

  const root = { replaceChildren() {} }
  const documentStub = {
    getElementById() {
      return root
    },
    createElement() {
      return {
        style: { cssText: "" },
        setAttribute() {},
        append() {},
        replaceChildren() {},
        addEventListener() {},
        textContent: "",
        type: "",
      }
    },
  }
  const windowStub = {
    location: {
      hash: `#${"S".repeat(43)}`,
      pathname: "/shared/shr_1/reports/report-1",
      search: "?caller=discarded",
    },
    history: {
      state: null,
      replaceState: options.replaceState,
    },
  }
  const consoleStub = { error() {} }
  const execute = new Function(
    "window",
    "document",
    "console",
    "loadSharedMain",
    executableSource
  ) as (
    windowValue: typeof windowStub,
    documentValue: typeof documentStub,
    consoleValue: typeof consoleStub,
    loadSharedMain: SharedShellHarnessOptions["loadSharedMain"]
  ) => Promise<void>

  await execute(windowStub, documentStub, consoleStub, options.loadSharedMain)
}
