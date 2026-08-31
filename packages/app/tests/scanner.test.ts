import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { routePatternKey, scanAppRoutes, scanPages } from "../src/scanner"

describe("custom app route discovery", () => {
  let tempRoot = ""
  let appDir = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sixb-app-scanner-"))
    appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
  })

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  test("discovers pages and descendant layouts without treating the root layout as a route", async () => {
    await mkdir(join(appDir, "analytics", "reports", "[reportId]"), { recursive: true })
    await mkdir(join(appDir, "_components"), { recursive: true })
    await mkdir(join(appDir, "public"), { recursive: true })
    await Promise.all([
      writeFile(join(appDir, "layout.tsx"), "export default function Layout() { return null }\n"),
      writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n"),
      writeFile(
        join(appDir, "analytics", "layout.tsx"),
        "export default function Layout() { return null }\n"
      ),
      writeFile(
        join(appDir, "analytics", "page.ts"),
        "export default function Page() { return null }\n"
      ),
      writeFile(
        join(appDir, "analytics", "reports", "[reportId]", "layout.tsx"),
        "export default function Layout() { return null }\n"
      ),
      writeFile(
        join(appDir, "analytics", "reports", "[reportId]", "page.tsx"),
        "export default function Page() { return null }\n"
      ),
      writeFile(
        join(appDir, "_components", "page.tsx"),
        "export default function Ignored() { return null }\n"
      ),
      writeFile(
        join(appDir, "public", "page.tsx"),
        "export default function Asset() { return null }\n"
      ),
    ])

    const discovery = await scanAppRoutes(appDir)

    expect(discovery.pages.map(({ path, relativePath }) => ({ path, relativePath }))).toEqual([
      { path: "/", relativePath: "page.tsx" },
      { path: "/analytics", relativePath: "analytics/page.ts" },
      {
        path: "/analytics/reports/:reportId",
        relativePath: "analytics/reports/[reportId]/page.tsx",
      },
    ])
    expect(discovery.layouts.map(({ path, relativePath }) => ({ path, relativePath }))).toEqual([
      { path: "/analytics", relativePath: "analytics/layout.tsx" },
      {
        path: "/analytics/reports/:reportId",
        relativePath: "analytics/reports/[reportId]/layout.tsx",
      },
    ])
    expect(await scanPages(appDir)).toEqual([...discovery.pages])
  })

  test("returns an empty discovery for a missing app directory", async () => {
    await expect(scanAppRoutes(join(tempRoot, "missing"))).resolves.toEqual({
      pages: [],
      layouts: [],
    })
  })

  test("rejects page.ts and page.tsx at the same route", async () => {
    await writeFile(join(appDir, "page.ts"), "export default function Page() { return null }\n")
    await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n")

    await expect(scanAppRoutes(appDir)).rejects.toThrow(
      "Conflicting page modules for route '/': app/page.ts and app/page.tsx"
    )
  })

  test("rejects dynamic siblings that match the same URLs", async () => {
    await mkdir(join(appDir, "customers", "[id]"), { recursive: true })
    await mkdir(join(appDir, "customers", "[slug]"), { recursive: true })

    await expect(scanAppRoutes(appDir)).rejects.toThrow(
      "Ambiguous route directories '[id]' and '[slug]' under app/customers"
    )
  })

  test("rejects unsupported dynamic syntax and framework-owned paths", async () => {
    await mkdir(join(appDir, "reports", "[...slug]"), { recursive: true })
    await expect(scanAppRoutes(appDir)).rejects.toThrow("catch-all and partial dynamic segments")

    await rm(join(appDir, "reports"), { recursive: true, force: true })
    await mkdir(join(appDir, "api"), { recursive: true })
    await writeFile(
      join(appDir, "api", "page.tsx"),
      "export default function Page() { return null }\n"
    )
    await expect(scanAppRoutes(appDir)).rejects.toThrow(
      "resolves to reserved framework path '/api'"
    )

    await rm(join(appDir, "api"), { recursive: true, force: true })
    await mkdir(join(appDir, "Docs"), { recursive: true })
    await writeFile(
      join(appDir, "Docs", "page.tsx"),
      "export default function Page() { return null }\n"
    )
    await expect(scanAppRoutes(appDir)).rejects.toThrow(
      "resolves to reserved framework path '/Docs'"
    )

    await rm(join(appDir, "Docs"), { recursive: true, force: true })
    await mkdir(join(appDir, "(admin)"), { recursive: true })
    await expect(scanAppRoutes(appDir)).rejects.toThrow("Route groups are not supported yet")
  })

  test("normalizes case and parameter labels when comparing route ownership", () => {
    expect(routePatternKey("/Agents/:id")).toBe(routePatternKey("/agents/:threadId"))
    expect(routePatternKey("/")).toBe("/")
  })
})
