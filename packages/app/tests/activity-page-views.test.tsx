import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import React, { type ComponentType } from "react"
import {
  MemoryRouter,
  matchRoutes,
  type NavigateFunction,
  useLocation,
  useNavigate,
} from "react-router-dom"
import { generateAppEntry } from "../src/codegen"
import { installDom } from "./helpers/dom"

installDom(["document", "navigator", "Node", "Element", "HTMLElement", "Event", "EventTarget"])

/**
 * Runs the generated page-view reporter inside a real router. Reproduce: report
 * `location.pathname`, skip the recorded-route check, or key the effect on `location.key`, and
 * these assertions fail, with a shared link's basename too.
 */
test.each([
  "",
  "/shared/shr_1",
])("page views report route patterns, never URL values (basename '%s')", async (basename) => {
  const root = await mkdtemp(join(tmpdir(), "sixb-activity-route-"))
  try {
    const generated = join(root, ".sixb", "generated")
    await mkdir(join(root, "app"), { recursive: true })
    await generateAppEntry(root, generated)
    const runtime = await readFile(join(generated, "app-runtime.tsx"), "utf-8")

    const start = runtime.indexOf("const routePatterns =")
    const end = runtime.indexOf("function AppRoutes()", start)
    expect(start).toBeGreaterThan(-1)

    const received: (string | null)[] = []
    const create = new Function(
      "React",
      "useLocation",
      "matchRoutes",
      "recordSixbPageView",
      "routePaths",
      "activityRoutePaths",
      `${runtime.slice(start, end)};return ActivityPageView`
    )
    const Reporter = create(
      React,
      useLocation,
      matchRoutes,
      (route: string | null) => received.push(route),
      ["/invoices/:id", "/invoices/new", "/settings/personal"],
      ["/invoices/:id", "/invoices/new"]
    ) as ComponentType

    const visit = async (path: string) => {
      received.length = 0
      render(
        <MemoryRouter basename={basename} initialEntries={[`${basename}${path}`]}>
          <Reporter />
        </MemoryRouter>
      )
      await waitFor(() => expect(received).toHaveLength(1))
      cleanup()
      return received[0]
    }

    expect(await visit("/invoices/private-id?token=secret#sensitive")).toBe("/invoices/:id")
    expect(await visit("/invoices/new")).toBe("/invoices/new")
    // A built-in section and an unknown path are not recorded.
    expect(await visit("/settings/personal")).toBeNull()
    expect(await visit("/unknown-private-value")).toBeNull()

    // A changed search or hash, or the same path again, is the page already viewed.
    let navigate: NavigateFunction = () => undefined
    function Navigator() {
      navigate = useNavigate()
      return null
    }
    received.length = 0
    render(
      <MemoryRouter basename={basename} initialEntries={[`${basename}/invoices/new`]}>
        <Reporter />
        <Navigator />
      </MemoryRouter>
    )
    await waitFor(() => expect(received).toEqual(["/invoices/new"]))

    act(() => navigate("/invoices/new?tab=lines#total"))
    act(() => navigate("/invoices/new"))
    await Bun.sleep(10)
    expect(received).toEqual(["/invoices/new"])

    act(() => navigate("/invoices/42"))
    await waitFor(() => expect(received).toEqual(["/invoices/new", "/invoices/:id"]))
    cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
