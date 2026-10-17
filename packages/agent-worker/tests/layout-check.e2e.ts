import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
<head><meta charset="utf-8"><title>Checked</title></head>
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
</body>
</html>`

describe.skipIf(!playwright)("the layout check in a browser", () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-layout-e2e-")))
    mkdirSync(join(root, "deck"))
    writeFileSync(join(root, "deck/index.html"), DECK)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test(
    "finds each problem on its slide, and nothing on a slide that reads well",
    async () => {
      // Reproduce the SVG case by measuring only CSS backgrounds in the probe: the label on its
      // bar reads as white on the slide. What the fifth slide shows from other artifacts is the
      // app's to draw: an empty box here, not a broken image. Reproduce the first slide's by measuring text lines at
      // their font's full height: a number set tight over its label reads as drawn over it.
      const result = await checkDeckLayout({
        handle: {
          sandbox: new LocalBashSandbox(root),
          env: {
            SIXB_PLAYWRIGHT: playwright,
            ...(process.env.SIXB_CHROMIUM ? { SIXB_CHROMIUM: process.env.SIXB_CHROMIUM } : {}),
          },
        },
        directory: join(root, "deck"),
        entry: new TextEncoder().encode(DECK),
        name: "checked",
        signal: AbortSignal.timeout(90_000),
      })
      if (result.status !== "checked") throw new Error(`The check did not run: ${result.reason}`)
      expect(result.screenshots).toHaveLength(5)
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
})
