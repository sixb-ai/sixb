import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, waitFor } from "@testing-library/react"
import { desktopPlatformOf, useDesktopDownload } from "../src/shell/desktop-download"
import { installDom } from "./helpers/dom"

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15"

installDom(["document", "Node", "Element", "HTMLElement", "MutationObserver"], {
  values: { navigator: { userAgent: MAC_SAFARI, maxTouchPoints: 0 } },
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete (globalThis as { sixbDesktop?: unknown }).sixbDesktop
})

/** The app's origin, serving a macOS release or not, recording what it's asked. */
function serve(released: boolean): string[] {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${String(input)}`)
    return new Response(null, { status: released ? 200 : 404 })
  }) as typeof fetch
  return asked
}

function Offer({ name }: { readonly name: string }) {
  const download = useDesktopDownload(name)
  return download ? (
    <a href={download.href} download={download.fileName}>
      {download.platform}
    </a>
  ) : null
}

function renderOffer(name = "Acme Ops") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Offer name={name} />
    </QueryClientProvider>
  )
}

describe("desktop download", () => {
  test("knows a Mac from its browser, and not an iPad asking for the Mac site", () => {
    expect(desktopPlatformOf({ userAgent: "", userAgentData: { platform: "macOS" } })).toBe(
      "darwin"
    )
    expect(desktopPlatformOf({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe("darwin")
    expect(desktopPlatformOf({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toBeNull()
    expect(desktopPlatformOf({ userAgent: "", userAgentData: { platform: "Windows" } })).toBeNull()
    expect(desktopPlatformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBeNull()
  })

  test("offers the release for this Mac, named after the app", async () => {
    const asked = serve(true)
    const view = renderOffer("Acme: Ops")

    const link = await waitFor(() => view.getByText("darwin"))
    expect(link.getAttribute("href")).toBe("/__sixb/desktop/darwin/install.dmg")
    expect(link.getAttribute("download")).toBe("Acme- Ops.dmg")
    expect(asked).toEqual(["HEAD /__sixb/desktop/darwin/install.dmg"])
  })

  test("offers nothing until a release is published", async () => {
    const asked = serve(false)
    const view = renderOffer()

    await waitFor(() => expect(asked).toHaveLength(1))
    expect(view.container.innerHTML).toBe("")
  })

  // Guard check: drop `desktop === null` from the query's `enabled`, and this asks the server.
  test("doesn't ask from inside the desktop app", async () => {
    ;(globalThis as { sixbDesktop?: unknown }).sixbDesktop = { platform: "darwin" }
    const asked = serve(true)
    const view = renderOffer()

    // A tick is time enough for the query to ask, as the guard check shows.
    await Bun.sleep(0)
    expect(view.container.innerHTML).toBe("")
    expect(asked).toEqual([])
  })
})
