import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { MemoryRouter, type RouteObject, useRoutes } from "react-router-dom"
import { generateRouteManifest } from "../src/codegen"
import { scanAppRoutes } from "../src/scanner"
import { installDom } from "./helpers/dom"

const browserWindow = installDom(
  [
    "document",
    "location",
    "history",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLAnchorElement",
    "Event",
    "EventTarget",
    "MouseEvent",
    "MutationObserver",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ],
  { url: "https://app.sixb.test/" }
)

beforeEach(() => {
  browserWindow.history.replaceState({}, "", "/")
  browserWindow.document.body.replaceChildren()
})

afterEach(async () => {
  await Bun.sleep(0)
})

describe("generated nested layouts", () => {
  test.each([
    "",
    "/shared/shr_1",
  ])("preserves nested layout state and params with basename '%s'", async (basename) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-app-layout-runtime-"))
    const appDir = join(projectRoot, "app")
    const reportDir = join(appDir, "analytics", "reports", "[reportId]")
    const detailsDir = join(reportDir, "details")
    const generatedDir = join(projectRoot, ".sixb", "generated")

    try {
      await mkdir(detailsDir, { recursive: true })
      await Promise.all([
        writeFile(
          join(appDir, "analytics", "layout.tsx"),
          [
            'import { useState, type PropsWithChildren } from "react"',
            "let mounts = 0",
            "export default function AnalyticsLayout({ children }: PropsWithChildren) {",
            "  const [instance] = useState(() => ++mounts)",
            '  return <section data-testid="analytics-layout">',
            '    <span data-testid="analytics-instance">{instance}</span>',
            "    {children}",
            "  </section>",
            "}",
            "",
          ].join("\n")
        ),
        writeFile(
          join(reportDir, "layout.tsx"),
          [
            'import { useState, type PropsWithChildren } from "react"',
            'import { Link, useParams } from "react-router-dom"',
            "let mounts = 0",
            "export default function ReportLayout({ children }: PropsWithChildren) {",
            "  const [instance] = useState(() => ++mounts)",
            "  const { reportId } = useParams()",
            '  return <section data-testid="report-layout">',
            '    <span data-testid="report-instance">{instance}</span>',
            '    <span data-testid="layout-param">{reportId}</span>',
            '    <Link to={"/analytics/reports/" + reportId + "/details"}>Report details</Link>',
            '    <Link to="/analytics/reports/second/details">Second report</Link>',
            "    {children}",
            "  </section>",
            "}",
            "",
          ].join("\n")
        ),
        writeFile(
          join(reportDir, "page.tsx"),
          [
            'import { useParams } from "react-router-dom"',
            "export default function ReportPage() {",
            "  const { reportId } = useParams()",
            '  return <p data-testid="page-param">summary:{reportId}</p>',
            "}",
            "",
          ].join("\n")
        ),
        writeFile(
          join(detailsDir, "page.tsx"),
          [
            'import { useParams } from "react-router-dom"',
            "export default function ReportDetailsPage() {",
            "  const { reportId } = useParams()",
            '  return <p data-testid="page-param">details:{reportId}</p>',
            "}",
            "",
          ].join("\n")
        ),
      ])
      await linkDependencies(projectRoot, ["react", "react-dom", "react-router-dom"])

      const discovery = await scanAppRoutes(appDir)
      const manifestPath = await generateRouteManifest([...discovery.pages], generatedDir, {
        layouts: discovery.layouts,
      })
      const generated = (await import(
        `${pathToFileURL(manifestPath).href}?runtime-layout-test`
      )) as {
        readonly routes: RouteObject[]
      }

      function TestRoutes() {
        return useRoutes(generated.routes)
      }

      const rendered = render(
        <MemoryRouter
          basename={basename || "/"}
          initialEntries={[`${basename}/analytics/reports/first`]}
        >
          <TestRoutes />
        </MemoryRouter>
      )

      expect(rendered.getByTestId("analytics-instance").textContent).toBe("1")
      expect(rendered.getByTestId("report-instance").textContent).toBe("1")
      expect(rendered.getByTestId("layout-param").textContent).toBe("first")
      expect(rendered.getByTestId("page-param").textContent).toBe("summary:first")
      expect(rendered.getByRole("link", { name: "Report details" }).getAttribute("href")).toBe(
        `${basename}/analytics/reports/first/details`
      )

      fireEvent.click(rendered.getByRole("link", { name: "Report details" }))

      await waitFor(() =>
        expect(rendered.getByTestId("page-param").textContent).toBe("details:first")
      )
      expect(rendered.getByTestId("analytics-instance").textContent).toBe("1")
      expect(rendered.getByTestId("report-instance").textContent).toBe("1")

      fireEvent.click(rendered.getByRole("link", { name: "Second report" }))

      await waitFor(() =>
        expect(rendered.getByTestId("page-param").textContent).toBe("details:second")
      )
      expect(rendered.getByTestId("layout-param").textContent).toBe("second")
      expect(rendered.getByTestId("analytics-instance").textContent).toBe("1")
      expect(rendered.getByTestId("report-instance").textContent).toBe("1")
      // Regression guard: removing the nested layout RouteObjects makes these assertions fail;
      // the two page routes also prove that shared feature state survives sibling navigation.
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

async function linkDependencies(projectRoot: string, packages: readonly string[]): Promise<void> {
  // Resolved as this package resolves them.
  const appRoot = resolve(import.meta.dir, "..")

  for (const name of packages) {
    const packageDir = dirname(Bun.resolveSync(`${name}/package.json`, appRoot))
    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(packageDir, target)
  }
}
