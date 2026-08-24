import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SharedAccessClient } from "@sixb/client/shared"
import { buildApp } from "../src/build"
import { generateSharedAppEntry, generateSharedRouteManifest } from "../src/codegen"
import { createCustomApp } from "../src/createCustomApp"
import { type PageRoute, partitionAppRoutes } from "../src/scanner"
import {
  bootstrapSharedAppAccess,
  consumeSharedAppFragmentSecret,
  SharedAppUnavailableError,
} from "../src/shared-runtime"

const publishedReportRoute: PageRoute = {
  path: "/shared/published-report/:grantId",
  filePath: "/project/app/shared/published-report/[grantId]/page.tsx",
  relativePath: "shared/published-report/[grantId]/page.tsx",
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

async function linkSharedAppDependencies(projectRoot: string): Promise<void> {
  const appPackageRoot = resolve(import.meta.dir, "..")
  const targets = new Map<string, string>([
    ["@sixb/app", appPackageRoot],
    ["@sixb/client", resolve(appPackageRoot, "../client")],
    ["@tanstack/react-query", join(appPackageRoot, "node_modules", "@tanstack/react-query")],
    ["react", join(appPackageRoot, "node_modules", "react")],
    ["react-dom", join(appPackageRoot, "node_modules", "react-dom")],
    ["react-router-dom", join(appPackageRoot, "node_modules", "react-router-dom")],
  ])

  for (const [name, source] of targets) {
    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(resolve(target, ".."), { recursive: true })
    await symlink(source, target, "dir")
  }
}

describe("shared app route boundary", () => {
  test("partitions only the canonical shared-page convention", () => {
    const applicationRoute: PageRoute = {
      path: "/reports",
      filePath: "/project/app/reports/page.tsx",
      relativePath: "reports/page.tsx",
    }

    expect(partitionAppRoutes([applicationRoute, publishedReportRoute])).toEqual({
      applicationRoutes: [applicationRoute],
      sharedRoutes: [{ ...publishedReportRoute, shareTypeId: "published-report" }],
    })
  })

  test.each([
    "shared/page.tsx",
    "shared/published-report/page.tsx",
    "shared/published-report/[token]/page.tsx",
    "shared/[shareTypeId]/[grantId]/page.tsx",
    "shared/published-report/[grantId]/details/page.tsx",
  ])("rejects malformed public shared route %s", (relativePath) => {
    expect(() =>
      partitionAppRoutes([
        {
          path: `/${relativePath.replace(/\/page\.tsx$/, "")}`,
          filePath: `/project/app/${relativePath}`,
          relativePath,
        },
      ])
    ).toThrow("Shared pages must use app/shared/<shareTypeId>/[grantId]/page.tsx")
  })

  test("generates a manifest that binds each page to its declared ShareType", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-shared-manifest-"))
    try {
      const manifestPath = await generateSharedRouteManifest(
        [{ ...publishedReportRoute, shareTypeId: "published-report" }],
        root
      )
      const manifest = await readFile(manifestPath, "utf-8")

      expect(manifest).toContain('shareTypeId: "published-report"')
      expect(manifest).toContain('path: "/shared/published-report/:grantId"')
      expect(manifest).toContain("component: SharedPage0")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("shared app bootstrap", () => {
  const context = {
    authenticated: true as const,
    csrfToken: "csrf",
    grant: {
      id: "shr_1",
      shareTypeId: "published-report",
      target: { objectTypeId: "PublishedReport", primaryId: "report-1" },
      grants: [{ capability: "view" as const, objectTypeId: "PublishedReport" }],
      expiresAt: "2026-09-01T12:00:00.000Z",
    },
    session: { expiresAt: "2026-08-22T12:15:00.000Z" },
  }
  const resource = {
    primaryId: "report-1",
    objectTypeId: "PublishedReport",
    properties: { title: "Published report" },
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
  }

  function client(overrides: Partial<SharedAccessClient> = {}): SharedAccessClient {
    return {
      exchange: mock(async () => context),
      getSession: mock(async () => context),
      getResource: mock(async () => resource),
      requestAction: mock(async () => ({
        runId: "run-1",
        queuedAt: "2026-08-22T12:00:00.000Z",
        created: true,
      })),
      signOut: mock(async () => ({ signedOut: true as const })),
      ...overrides,
    }
  }

  test("clears the fragment before exchanging it and loads the exact resource", async () => {
    const calls: string[] = []
    const sharedClient = client({
      exchange: mock(async (secret: string) => {
        calls.push(`exchange:${secret}`)
        return context
      }),
    })
    const history = {
      state: { fixture: true },
      replaceState: mock((_state: unknown, _unused: string, url?: string | URL | null) => {
        calls.push(`replace:${String(url)}`)
      }),
    }

    const fragmentSecret = consumeSharedAppFragmentSecret(
      {
        hash: "#abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE",
        pathname: "/shared/published-report/shr_1",
        search: "?source=email",
      },
      history
    )
    const result = await bootstrapSharedAppAccess({
      expectedShareTypeId: "published-report",
      grantId: "shr_1",
      fragmentSecret,
      client: sharedClient,
    })

    expect(calls[0]).toBe("replace:/shared/published-report/shr_1?source=email")
    expect(calls[1]?.startsWith("exchange:")).toBe(true)
    expect(sharedClient.getSession).not.toHaveBeenCalled()
    expect(result).toEqual({ access: context, resource })
  })

  test("resumes an existing shared session when the URL has no fragment", async () => {
    const sharedClient = client()
    await bootstrapSharedAppAccess({
      expectedShareTypeId: "published-report",
      grantId: "shr_1",
      fragmentSecret: null,
      client: sharedClient,
    })

    expect(sharedClient.exchange).not.toHaveBeenCalled()
    expect(sharedClient.getSession).toHaveBeenCalledTimes(1)
  })

  test("rejects a valid grant opened through another ShareType page", async () => {
    expect(
      bootstrapSharedAppAccess({
        expectedShareTypeId: "proposal-approval",
        grantId: "shr_1",
        fragmentSecret: null,
        client: client(),
      })
    ).rejects.toBeInstanceOf(SharedAppUnavailableError)
  })

  test("rejects a resource that does not match the grant target", async () => {
    expect(
      bootstrapSharedAppAccess({
        expectedShareTypeId: "published-report",
        grantId: "shr_1",
        fragmentSecret: null,
        client: client({
          getResource: mock(async () => ({ ...resource, primaryId: "report-2" })),
        }),
      })
    ).rejects.toBeInstanceOf(SharedAppUnavailableError)
  })
})

describe("shared app entry", () => {
  let root = ""

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  test("generates an isolated entry without application auth or the global client", async () => {
    root = await mkdtemp(join(tmpdir(), "sixb-shared-entry-"))
    const appDir = join(root, "app")
    const generatedDir = join(root, ".sixb", "generated")
    await mkdir(join(appDir, "shared"), { recursive: true })
    await writeFile(
      join(appDir, "shared", "layout.tsx"),
      "export default function Layout({ children }) { return children }\n"
    )

    const { htmlPath, mainPath } = await generateSharedAppEntry(root, generatedDir, {
      apiBaseUrl: "https://api.example.com",
    })
    const html = await readFile(htmlPath, "utf-8")
    const main = await readFile(mainPath, "utf-8")
    const bootstrap = await readFile(join(generatedDir, "shared-bootstrap.ts"), "utf-8")

    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />')
    expect(html).toContain('<meta name="referrer" content="no-referrer" />')
    expect(html).not.toContain('rel="manifest"')
    expect(main).toContain('from "@sixb/app/shared"')
    expect(main).toContain('from "./shared-routes"')
    expect(main).toContain('from "../../app/shared/layout.tsx"')
    expect(main).toContain("<SharedAccessBoundary")
    expect(main).toContain("consumeFragmentSecret={consumeFragmentSecret}")
    expect(main).not.toContain("configureSixbBrowserClient")
    expect(main).not.toContain("requireSixbBrowserAuthSession")
    expect(main).not.toContain('from "@sixb/client"')
    expect(bootstrap).not.toContain("import ")
    expect(bootstrap.indexOf("history.replaceState")).toBeLessThan(
      bootstrap.indexOf('import("./shared-main")')
    )
    expect(bootstrap.indexOf("fragmentSecret = null")).toBeLessThan(
      bootstrap.indexOf("startSharedApp(secret)")
    )
  })

  test("serves separate dev shells and secures the public shared response", async () => {
    const workspaceTempDir = resolve(import.meta.dir, "../../..", ".local", "test-tmp")
    await mkdir(workspaceTempDir, { recursive: true })
    root = await mkdtemp(join(workspaceTempDir, "sixb-shared-dev-"))
    await mkdir(join(root, "app", "shared", "published-report", "[grantId]"), {
      recursive: true,
    })
    await writeFile(
      join(root, "app", "page.tsx"),
      "export default function AppPage() { return <main>Application shell</main> }\n"
    )
    await writeFile(
      join(root, "app", "shared", "published-report", "[grantId]", "page.tsx"),
      "export default function SharedPage() { return <main>Shared shell</main> }\n"
    )
    await linkSharedAppDependencies(root)

    const port = await getFreePort()
    const app = await createCustomApp({
      rootDir: root,
      apiBaseUrl: "https://api.example.com",
      authEnabled: true,
      agentRoutes: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      const application = await fetch(`http://127.0.0.1:${port}/`)
      const shared = await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`)
      const internalSharedShell = await fetch(
        `http://127.0.0.1:${port}/__sixb/generated/shared-app-shell`
      )

      expect(application.status).toBe(200)
      expect(shared.status).toBe(200)
      expect(internalSharedShell.status).toBe(404)
      const applicationHtml = await application.text()
      const sharedHtml = await shared.text()
      const sharedCsp = shared.headers.get("content-security-policy") ?? ""
      const scriptNonce = sharedHtml.match(/<script nonce="([^"]+)"/)?.[1]
      expect(applicationHtml).not.toBe(sharedHtml)
      expect(scriptNonce).toBeTruthy()
      expect(sharedCsp).toContain(`'nonce-${scriptNonce}'`)
      expect(shared.headers.get("cache-control")).toBe("no-store")
      expect(shared.headers.get("referrer-policy")).toBe("no-referrer")
      expect(shared.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
      expect(sharedCsp).toContain("connect-src 'self' https://api.example.com")
      expect(
        await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`, {
          method: "POST",
        })
      ).toHaveProperty("status", 404)

      const applicationRoutes = await readFile(
        join(root, ".sixb", "generated", "routes.ts"),
        "utf-8"
      )
      const sharedRoutes = await readFile(
        join(root, ".sixb", "generated", "shared-routes.ts"),
        "utf-8"
      )
      expect(applicationRoutes).not.toContain("published-report")
      expect(sharedRoutes).toContain("published-report")
    } finally {
      await server.stop()
    }
  }, 30_000)

  test("builds and serves the shared entry separately in production", async () => {
    const workspaceTempDir = resolve(import.meta.dir, "../../..", ".local", "test-tmp")
    await mkdir(workspaceTempDir, { recursive: true })
    root = await mkdtemp(join(workspaceTempDir, "sixb-shared-build-"))
    await mkdir(join(root, "app", "shared", "published-report", "[grantId]"), {
      recursive: true,
    })
    await writeFile(
      join(root, "app", "page.tsx"),
      "export default function AppPage() { return <main>Application shell</main> }\n"
    )
    await writeFile(
      join(root, "app", "shared", "published-report", "[grantId]", "page.tsx"),
      "export default function SharedPage() { return <main>Shared shell</main> }\n"
    )
    await linkSharedAppDependencies(root)

    const outdir = join(root, ".sixb", "dist", "app")
    await mkdir(join(root, "app", "public"), { recursive: true })
    await writeFile(
      join(root, "app", "public", "shared-index.html"),
      "<!doctype html><p>Public file must not replace the shared shell.</p>\n"
    )

    const app = await createCustomApp({ rootDir: root, authEnabled: true, agentRoutes: false })
    const build = await app.build({ outdir })
    expect(build.success).toBe(true)
    expect(await readFile(join(outdir, "shared-index.html"), "utf-8")).not.toContain(
      "Public file must not replace"
    )

    const port = await getFreePort()
    const server = await app.start({
      host: "127.0.0.1",
      port,
      outdir,
      apiBaseUrl: "https://api.example.com",
      authEnabled: true,
    })
    try {
      const application = await fetch(`http://127.0.0.1:${port}/`)
      const shared = await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`)
      const rawSharedShell = await fetch(`http://127.0.0.1:${port}/shared-index.html`)
      expect(application.status).toBe(200)
      expect(shared.status).toBe(200)
      expect(rawSharedShell.status).toBe(404)
      expect(await application.text()).not.toBe(await shared.text())
      expect(shared.headers.get("content-security-policy")).toContain(
        "connect-src 'self' https://api.example.com"
      )
    } finally {
      await server.stop()
    }
  }, 30_000)

  test("builds both HTML entries with root-relative assets", async () => {
    root = await mkdtemp(join(tmpdir(), "sixb-shared-build-entries-"))
    const generatedDir = join(root, "generated")
    const outdir = join(root, "dist")
    await mkdir(generatedDir, { recursive: true })
    await writeFile(join(generatedDir, "main.ts"), 'document.body.dataset.entry = "app"\n')
    await writeFile(
      join(generatedDir, "shared-main.ts"),
      'document.body.dataset.entry = "shared"\n'
    )
    await writeFile(
      join(generatedDir, "index.html"),
      '<!doctype html><body><script type="module" src="./main.ts"></script></body>\n'
    )
    await writeFile(
      join(generatedDir, "shared-index.html"),
      '<!doctype html><body><script type="module" src="./shared-main.ts"></script></body>\n'
    )

    const result = await buildApp({
      entryPath: join(generatedDir, "index.html"),
      sharedEntryPath: join(generatedDir, "shared-index.html"),
      outdir,
    })

    expect(result.success).toBe(true)
    const applicationHtml = await readFile(join(outdir, "index.html"), "utf-8")
    const sharedHtml = await readFile(join(outdir, "shared-index.html"), "utf-8")
    expect(applicationHtml).toMatch(/src=["']\/[^"']+\.js["']/)
    expect(sharedHtml).toMatch(/src=["']\/[^"']+\.js["']/)
    expect(applicationHtml).not.toBe(sharedHtml)
    expect(await Bun.file(join(generatedDir, "index.sixb-bundle.html")).exists()).toBe(false)
    expect(await Bun.file(join(generatedDir, "shared-index.sixb-bundle.html")).exists()).toBe(false)
  })
})
