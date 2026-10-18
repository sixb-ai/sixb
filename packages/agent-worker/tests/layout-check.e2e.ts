import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactTheme } from "@sixb/core/artifacts"
import { checkDeckLayout } from "../src/artifacts/layout-check/layout-check"
import { LocalBashSandbox } from "./helpers"

// The layout check in a real headless Chromium, through Playwright for Node as the agent image
// ships it: at /opt/sixb/js/node_modules/playwright, or where SIXB_PLAYWRIGHT points (with
// SIXB_CHROMIUM naming a browser when Playwright has none of its own). Without either it skips.
//
//   SIXB_PLAYWRIGHT=<dir>/node_modules/playwright-core \
//   SIXB_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   bun test ./packages/agent-worker/tests/layout-check.e2e.ts
const IMAGE_PLAYWRIGHT = "/opt/sixb/js/node_modules/playwright"
const playwright =
  process.env.SIXB_PLAYWRIGHT ?? (existsSync(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : "")

const DECK = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Checked</title>
<style>#photo::before { content: ""; position: absolute; inset: 0; background: linear-gradient(to top, rgb(0 0 0 / 0.6), transparent) }</style></head>
<body>
  <section class="slide title">
    <p class="eyebrow"><span>Q3 2026</span><span>Review</span></p>
    <h1>Q3 review</h1>
    <p>Everything on this slide reads well.</p>
    <div style="position: absolute; left: 900px; top: 120px">
      <div style="font-size: 120px; line-height: 0.7">94%</div>
      <div>Within SLA</div>
    </div>
    <p class="source">October 22, 2026</p>
  </section>
  <section class="slide">
    <h2>Small and pale</h2>
    <p style="font-size: 14px">Fine print</p>
    <p style="color: #bbbbbb">Pale words</p>
  </section>
  <section class="slide">
    <h2>Past the edge</h2>
    <div style="position: absolute; left: 1100px; top: 300px; width: 400px">Off the slide</div>
    <img src="img/missing.png" alt="" style="width: 200px; height: 100px">
    <div style="height: 40px; overflow: hidden">One<br>Two<br>Three</div>
  </section>
  <section class="slide">
    <h2>A heading</h2>
    <p style="margin-top: -60px">Over the heading</p>
    <div style="position: absolute; left: 96px; top: 600px">Into the footer</div>
  </section>
  <section class="slide chart">
    <h2>Charts</h2>
    <svg viewBox="0 0 400 100" style="width: 400px; height: 100px" role="img" aria-label="A bar">
      <rect width="300" height="60" fill="#101010"/>
      <text x="12" y="40" font-size="24" fill="#ffffff">On its bar</text>
    </svg>
    <svg viewBox="0 0 2000 200" style="width: 400px; height: 40px" role="img" aria-label="Tiny">
      <text x="0" y="120" font-size="60" fill="var(--foreground)">Tiny label</text>
    </svg>
    <sixb-embed src="artifact:art_0000000000#chart=revenue" title="Revenue" style="height: 160px"></sixb-embed>
    <img src="artifact:art_0000000000/figures/map.png" alt="" style="width: 200px; height: 80px">
  </section>
  <section class="slide image bleed" id="photo">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'%3E%3Crect width='16' height='9' fill='%23303030'/%3E%3C/svg%3E" alt="">
    <h2 style="position: absolute; left: 96px; bottom: 88px; z-index: 1; color: #ffffff">On a photo</h2>
  </section>
</body>
</html>`

/** A deck whose script stops answering once the check asks for its second slide. */
const HANGING_DECK = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hangs</title></head>
<body>
  <section class="slide"><h2>One</h2></section>
  <section class="slide"><h2>Two</h2></section>
  <script>
    addEventListener("message", (event) => {
      if (event.data?.method === "goto" && event.data.params?.slide === 2) {
        setTimeout(() => { for (;;) {} })
      }
    })
  </script>
</body>
</html>`

/** The processes running now whose command line names Playwright's browser profile. */
function browsers(): Set<string> {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString()
  return new Set(
    ps
      .split("\n")
      .filter((line) => line.includes("playwright_chromiumdev_profile"))
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
  )
}

describe.skipIf(!playwright)("the layout check in a browser", () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-layout-e2e-")))
    mkdirSync(join(root, "deck/img"), { recursive: true })
    writeFileSync(join(root, "deck/index.html"), DECK)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const check = (deck: string, files: readonly string[], name: string, theme?: ArtifactTheme) =>
    checkDeckLayout({
      handle: {
        sandbox: new LocalBashSandbox(root),
        env: {
          SIXB_PLAYWRIGHT: playwright,
          ...(process.env.SIXB_CHROMIUM ? { SIXB_CHROMIUM: process.env.SIXB_CHROMIUM } : {}),
        },
      },
      directory: join(root, "deck"),
      files,
      entry: new TextEncoder().encode(deck),
      name,
      ...(theme ? { theme } : {}),
      signal: AbortSignal.timeout(90_000),
    })

  test(
    "finds each problem on its slide, and nothing on a slide that reads well",
    async () => {
      // Reproduce the SVG case by measuring only CSS backgrounds in the probe: the label on its
      // bar reads as white on the slide. What the fifth slide shows from other artifacts is the
      // app's to draw: an empty box here, not a broken image. Reproduce the first slide's by
      // measuring text lines at their font's full height: a number set tight over its label
      // reads as drawn over it. The sixth slide's heading is on a photo, whose colors no style
      // names: reproduce by measuring under the photo, or past it to the slide that its scrim
      // lifts above it in the stack, and the white heading reads as white on white.
      const result = await check(DECK, ["index.html"], "checked")
      if (result.status !== "checked") throw new Error(`The check did not run: ${result.reason}`)
      expect(result.screenshots).toHaveLength(6)
      const found = result.warnings.map((warning) => `${warning.part ?? "-"} ${warning.code}`)
      expect(found.sort()).toEqual(
        [
          "- layout_load_error",
          "2 layout_contrast",
          "2 layout_small_text",
          "3 layout_broken_image",
          "3 layout_clipped",
          "3 layout_outside",
          "4 layout_footer",
          "4 layout_overlap",
          "5 layout_small_text",
        ].sort()
      )
      expect(result.warnings.find((warning) => warning.part === "5")?.message).toContain(
        "“Tiny label” is 12px"
      )
    },
    { timeout: 120_000 }
  )

  test(
    "measures a deck in the mode and the tokens its theme.json sets",
    async () => {
      // The reader's frame applies the deck's theme.json over the app's theme. Reproduce by
      // measuring in Sixb's themes alone: the pale note passes, and the fixed ink fails in dark.
      const deck = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Themed</title></head><body>
  <section class="slide"><h2>A light deck</h2>
    <p class="note">A pale note</p>
    <p style="color: #202020">Ink that stays dark</p>
  </section></body></html>`
      const result = await check(deck, ["index.html"], "themed", {
        mode: "light",
        tokens: { "--muted-foreground": "#c8c8c8" },
      })
      if (result.status !== "checked") throw new Error(`The check did not run: ${result.reason}`)
      expect(result.warnings.map((warning) => warning.message)).toEqual([
        expect.stringContaining("p.note “A pale note” has a contrast of"),
      ])
    },
    { timeout: 120_000 }
  )

  test(
    "shows only the files the version publishes",
    async () => {
      // The reader gets the published files, so an image beside the deck that it does not
      // publish is missing for them. Reproduce by serving the deck's whole directory.
      const svg =
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2 1'><rect width='2' height='1'/></svg>"
      writeFileSync(join(root, "deck/img/listed.svg"), svg)
      writeFileSync(join(root, "deck/img/unlisted.svg"), svg)
      const deck = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Images</title></head><body>
  <section class="slide image"><h2>Two images</h2>
    <img src="img/listed.svg" alt="" style="width: 200px; height: 100px">
    <img src="img/unlisted.svg" alt="" style="width: 200px; height: 100px">
  </section></body></html>`
      const result = await check(deck, ["index.html", "img/listed.svg"], "published")
      if (result.status !== "checked") throw new Error(`The check did not run: ${result.reason}`)
      const messages = result.warnings.map((warning) => warning.message).join("\n")
      expect(messages).toContain("img/unlisted.svg did not load (404)")
      expect(messages).not.toContain("img/listed.svg")
      expect(result.warnings.map((warning) => warning.code)).toContain("layout_broken_image")
    },
    { timeout: 120_000 }
  )

  test(
    "reports what it found when the deck stops answering, and leaves no browser behind",
    async () => {
      // Reproduce by removing check.cjs's bounds and deadline: the check waits on the frozen
      // page until the command's timeout kills node, and Chromium keeps running.
      const before = browsers()
      const result = await check(HANGING_DECK, ["index.html"], "hanging")
      if (result.status !== "checked") throw new Error(`The check did not run: ${result.reason}`)
      expect(result.screenshots).toEqual([".sixb/agent/checks/hanging/slide-01.png"])
      expect(result.warnings.at(-1)).toMatchObject({ code: "layout_incomplete" })
      expect(result.warnings.at(-1)?.message).toContain("slide 2 in light mode did not respond")
      const left = () => [...browsers()].filter((pid) => !before.has(pid))
      for (let wait = 0; left().length > 0 && wait < 30; wait++) await Bun.sleep(100)
      expect(left()).toEqual([])
    },
    { timeout: 120_000 }
  )
})
