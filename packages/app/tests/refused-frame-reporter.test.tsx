import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { render } from "@testing-library/react"
import React, { type ComponentType } from "react"
import { generateAppEntry } from "../src/codegen"
import { installDom } from "./helpers/dom"

const browser = installDom(["document", "Node", "Element", "HTMLElement", "Event", "EventTarget"])
// Only the elements' src matters here: never fetch the pages they name.
browser.happyDOM.settings.disableIframePageLoading = true

afterEach(() => {
  document.body.replaceChildren()
})

async function generatedReporter(): Promise<ComponentType> {
  const root = await mkdtemp(join(tmpdir(), "sixb-refused-frame-"))
  try {
    const generated = join(root, ".sixb", "generated")
    await mkdir(join(root, "app"), { recursive: true })
    await generateAppEntry(root, generated)
    const runtime = await readFile(join(generated, "app-runtime.tsx"), "utf-8")

    const start = runtime.indexOf("function RefusedFrameReporter()")
    const end = runtime.indexOf("function pathInsideApp(", start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const source = new Bun.Transpiler({ loader: "tsx" }).transformSync(runtime.slice(start, end))
    return new Function("React", `${source};return RefusedFrameReporter`)(React) as ComponentType
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function frame(src: string): void {
  const element = document.createElement("iframe")
  element.src = src
  document.body.append(element)
}

function refuse(blockedURI: string, effectiveDirective = "frame-src"): void {
  const event = new browser.Event("securitypolicyviolation")
  Object.assign(event, { blockedURI, effectiveDirective })
  document.dispatchEvent(event as unknown as Event)
}

/**
 * Reproduce: drop the `frames.some(...)` check, and the artifact frame's destination is named
 * first; drop the directive check, and the image's site is; drop `reported`, and the SharePoint
 * origin is named twice.
 */
test("names the variable once for an <iframe> the page asked for, never for an artifact's navigation", async () => {
  const Reporter = await generatedReporter()
  const warn = spyOn(console, "warn").mockImplementation(() => undefined)

  try {
    frame("https://api.sixb.test/v1/artifact-frames/token/index.html")
    frame("https://contoso.sharepoint.com/sites/team/_layouts/15/embed.aspx?UniqueId=1")
    frame("https://maps.example/embed")
    render(<Reporter />)

    // An artifact frame that tries to leave: its src is still the API's address.
    refuse("https://collector.example/?rows=secret")
    // Another directive is not about frames, even from a framed site.
    refuse("https://maps.example/tile.png", "img-src")
    refuse("https://contoso.sharepoint.com/sites/team/_layouts/15/embed.aspx")
    refuse("https://contoso.sharepoint.com/sites/team/_layouts/15/embed.aspx")

    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      "[SixbApp] The app refused to frame https://contoso.sharepoint.com. Add each site a frame " +
        "loads, redirects included, to SIXB_APP_FRAME_ORIGINS on the app server.",
    ])
  } finally {
    warn.mockRestore()
  }
})
