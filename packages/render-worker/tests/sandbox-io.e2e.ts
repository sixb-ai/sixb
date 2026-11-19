import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { posix } from "node:path"
import { InMemoryBlobStorage, InMemoryStorage } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import {
  downloadIntoSandbox,
  inRenderSandbox,
  renderApiOrigin,
  runScript,
  scriptFiles,
  storeSandboxFile,
} from "../src/sandbox"
import { startDownloadApi } from "./download-api"

// A render that fetches a large file by URL, opens it in a real headless Chromium, and streams
// what it wrote back to blob storage, through Playwright for Node as the agent image ships it: at
// /opt/sixb/js/node_modules/playwright, or where SIXB_PLAYWRIGHT points (with SIXB_CHROMIUM naming
// a browser when Playwright has none of its own). Without either it skips.
//
//   SIXB_PLAYWRIGHT=<dir>/node_modules/playwright-core \
//   bun test ./packages/render-worker/tests/sandbox-io.e2e.ts
const IMAGE_PLAYWRIGHT = "/opt/sixb/js/node_modules/playwright"
const playwright =
  process.env.SIXB_PLAYWRIGHT ?? (existsSync(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : "")

/** A red pixel as a PNG, then 24 MiB a decoder never reads: an image as large as a film's still. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64"
)
const LARGE_PNG = Buffer.concat([PIXEL, Buffer.alloc(24 * 1024 * 1024)])

const SHOT_SCRIPT = `const path = require("node:path")
const { launch, serve, report } = require("./shared.cjs")
const [site, out] = process.argv.slice(2)
report(async () => {
  const browser = await launch()
  if (!browser) return { skipped: "no_browser" }
  const server = await serve(site)
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 200 } })
    await page.goto("http://127.0.0.1:" + server.address().port + "/index.html")
    const loaded = await page.evaluate(() => document.querySelector("img").naturalWidth)
    await page.screenshot({ path: out })
    return { loaded, bytes: require("node:fs").statSync(out).size }
  } finally {
    server.close()
    await browser.close()
  }
})
`

describe.skipIf(!playwright)("a render's large files", () => {
  test("come in by URL, open in the browser, and stream back out", async () => {
    // Reproduce by leaving the API's origin out of `reach` on a provider that enforces its
    // network: curl cannot reach the API, and the render fails before the browser opens.
    const host = {
      id: "renders",
      storage: new InMemoryStorage(),
      blobStorage: new InMemoryBlobStorage(),
      sandboxes: new LocalSandboxFactory({
        isolation: "none",
        env: {
          SIXB_PLAYWRIGHT: playwright,
          ...(process.env.SIXB_CHROMIUM ? { SIXB_CHROMIUM: process.env.SIXB_CHROMIUM } : {}),
        },
      }),
    }
    const still = await host.blobStorage.put({ body: LARGE_PNG, fileName: "still.png" })
    const api = startDownloadApi(host)
    try {
      const signal = new AbortController().signal
      const shot = await inRenderSandbox(
        host,
        "pictures a still",
        { timeoutMs: 120_000, signal, reach: [renderApiOrigin(host)] },
        async (sandbox, left, signal) => {
          const site = posix.join(sandbox.workingDirectory, "site")
          const out = posix.join(sandbox.workingDirectory, "shot.png")
          await downloadIntoSandbox(
            host,
            sandbox,
            [{ path: posix.join(site, "still.png"), file: still }],
            { timeoutMs: left(), signal, executionId: "render_e2e" }
          )
          await sandbox.writeFiles([
            {
              path: posix.join(site, "index.html"),
              contents: `<!doctype html><img src="still.png" style="width:200px;height:200px">`,
            },
            ...scriptFiles(sandbox, "shot.cjs", SHOT_SCRIPT),
          ])
          const { report, stderr } = await runScript(
            sandbox,
            posix.join(sandbox.workingDirectory, "shot.cjs"),
            [site, out],
            { timeoutMs: left(), signal }
          )
          expect(report, stderr).toMatchObject({ loaded: 1 })
          return storeSandboxFile(
            host.blobStorage,
            sandbox,
            {
              path: out,
              bytes: Number(report?.bytes),
              fileName: "shot.png",
              mediaType: "image/png",
            },
            { signal }
          )
        }
      )

      expect(api.served).toHaveLength(1)
      const stored = Buffer.from(
        await new Response(await host.blobStorage.open(shot.blobId)).arrayBuffer()
      )
      expect(stored.subarray(1, 4).toString("latin1")).toBe("PNG")
      expect(shot.sizeBytes).toBe(stored.byteLength)
    } finally {
      api.close()
    }
  }, 150_000)
})
