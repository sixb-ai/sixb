import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SharedAccessClient } from "@sixb/client/shared"
import { generateSharedAppEntry, generateSharedRouteManifest } from "../src/codegen"
import { type PageRoute, partitionAppRoutes } from "../src/scanner"
import {
  bootstrapSharedAppAccess,
  classifySharedAppFailure,
  consumeSharedAppFragmentSecret,
  SharedAppUnavailableError,
} from "../src/shared-runtime"

const publishedReportRoute: PageRoute = {
  path: "/shared/published-report/:grantId",
  filePath: "/project/app/shared/published-report/[grantId]/page.tsx",
  relativePath: "shared/published-report/[grantId]/page.tsx",
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

  test.each([
    ":report",
    ".report",
    "report name",
    "[shareTypeId]",
  ])("rejects route-unsafe ShareType id %s", (shareTypeId) => {
    expect(() =>
      partitionAppRoutes([
        {
          path: `/shared/${shareTypeId}/:grantId`,
          filePath: `/project/app/shared/${shareTypeId}/[grantId]/page.tsx`,
          relativePath: `shared/${shareTypeId}/[grantId]/page.tsx`,
        },
      ])
    ).toThrow("ShareType id")
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

  test("rejects a malformed fragment without attempting an exchange", async () => {
    const sharedClient = client()
    await expect(
      bootstrapSharedAppAccess({
        expectedShareTypeId: "published-report",
        grantId: "shr_1",
        fragmentSecret: "not-a-secret",
        client: sharedClient,
      })
    ).rejects.toBeInstanceOf(SharedAppUnavailableError)

    expect(sharedClient.exchange).not.toHaveBeenCalled()
  })

  test("signals an established session before loading the resource", async () => {
    const established: string[] = []
    await expect(
      bootstrapSharedAppAccess({
        expectedShareTypeId: "published-report",
        grantId: "shr_1",
        fragmentSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE",
        client: client({
          getResource: mock(async () => {
            throw { name: "SixbApiError", status: 503 }
          }),
        }),
        onAccessEstablished: () => established.push("established"),
      })
    ).rejects.toEqual({ name: "SixbApiError", status: 503 })

    expect(established).toEqual(["established"])
  })

  test("separates terminal, retryable, and unexpected bootstrap failures", () => {
    expect(classifySharedAppFailure(new SharedAppUnavailableError())).toBe("terminal")
    expect(
      classifySharedAppFailure({
        name: "SixbApiError",
        status: 401,
        code: "share.access_unavailable",
      })
    ).toBe("terminal")
    expect(classifySharedAppFailure({ name: "SixbApiError", status: 503 })).toBe("retryable")
    expect(classifySharedAppFailure(new TypeError("fetch failed"))).toBe("retryable")
    expect(classifySharedAppFailure(new Error("unexpected"))).toBe("unexpected")
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
    expect(bootstrap.indexOf("startSharedApp(secret)")).toBeLessThan(
      bootstrap.indexOf("fragmentSecret = null")
    )
    expect(bootstrap).toContain("Failed to load the shared app entry")
    expect(bootstrap).toContain("Try again")
  })
})
