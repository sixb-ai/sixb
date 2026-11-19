import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createArtifactFrame } from "@sixb/core/internal/artifacts/frames"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { getFreePort } from "./helpers"

// A video played in a real headless Chromium, in its sandboxed frame, as the app drives it: the
// HyperFrames runtime the frame serves plays, seeks, and pauses on the messages the app posts.
// Playwright for Node is found as the agent image ships it, at /opt/sixb/js/node_modules/playwright,
// or where SIXB_PLAYWRIGHT points (with SIXB_CHROMIUM naming a browser when Playwright has none of
// its own). Without either it skips.
//
//   SIXB_PLAYWRIGHT=<dir>/node_modules/playwright-core \
//   bun test ./packages/server/tests/artifact-video-playback.e2e.ts
const IMAGE_PLAYWRIGHT = "/opt/sixb/js/node_modules/playwright"
const playwright =
  process.env.SIXB_PLAYWRIGHT ?? (existsSync(IMAGE_PLAYWRIGHT) ? IMAGE_PLAYWRIGHT : "")

/** How long the browser has for the whole run: past it, the run is killed and fails. */
const RUN_BOUND_MS = 60_000

const PROJECT_ID = "video-playback"

/** One scene: a box a CSS animation slides 1000px across its 4 seconds, which HyperFrames drives. */
const INDEX = `<!doctype html>
<html><head><title>Box</title><style>html, body { margin: 0; background: #000; }</style></head><body>
<div id="root" data-composition-id="main" data-width="1280" data-height="720" data-duration="4">
  <div id="move" data-composition-id="move" data-composition-src="scenes/move.html" data-start="0" data-duration="4"></div>
</div>
</body></html>`
const SCENE = `<template>
  <div data-composition-id="move" data-width="1280" data-height="720">
    <div class="box"></div>
    <style>
      [data-composition-id="move"] .box { position: absolute; top: 300px; left: 0; width: 80px; height: 80px; background: #2bb3a6; animation: slide 4s linear both; }
      @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(1000px); } }
    </style>
  </div>
</template>`

/**
 * The app's side, as `renderers/video/hyperframes.ts` speaks: it posts controls to the frame and
 * reads the runtime's reports. The box's place is read inside the frame, where the picture is.
 */
const DRIVE = `
const { chromium } = require(process.env.SIXB_PLAYWRIGHT)
;(async () => {
  const browser = await chromium.launch(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {})
  try {
    const page = await browser.newPage()
    await page.goto(process.env.PLAYER_URL)
    await page.waitForFunction(() => window.reports.some((report) => report.type === "timeline"), null, { timeout: 20000 })
    const frame = page.frames().find((each) => each.url().includes("/api/artifact-frames/"))
    const box = () => frame.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".box")).transform).m41)
    const time = () => page.evaluate(() => window.reports.filter((report) => report.type === "state").at(-1).currentTime)
    const settle = () => page.waitForTimeout(400)
    const seen = { frame: await page.evaluate(() => window.frameEvents) }

    await page.evaluate(() => window.control("play"))
    await page.waitForTimeout(1000)
    seen.played = { time: await time(), box: await box() }

    await page.evaluate(() => window.control("seek", { timeSeconds: 1.5 }))
    await settle()
    seen.seeked = { time: await time(), box: await box() }

    await page.evaluate(() => window.control("play"))
    await page.waitForTimeout(500)
    await page.evaluate(() => window.control("pause"))
    await settle()
    seen.paused = { time: await time(), box: await box() }
    await page.waitForTimeout(800)
    seen.held = { time: await time(), box: await box() }
    console.log(JSON.stringify(seen))
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`

const PLAYER = (src: string) => `<!doctype html><html><body>
<iframe id="frame" src="${src}" sandbox="allow-scripts allow-modals" allow="autoplay; fullscreen" style="width: 1280px; height: 720px; border: 0"></iframe>
<script>
  window.reports = []
  window.frameEvents = []
  const frame = document.getElementById("frame")
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || !event.data) return
    if (event.data.source === "hf-preview") window.reports.push(event.data)
    if (event.data.protocol === "sixb-frame/1" && event.data.event) window.frameEvents.push(event.data.event)
  })
  window.control = (action, extra) => frame.contentWindow.postMessage({
    source: "hf-parent", type: "control", action, protocolVersion: 1,
    capabilities: ["seconds-time"], fps: { numerator: 30, denominator: 1 }, ...extra,
  }, "*")
</script></body></html>`

const cleanup: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const each of cleanup.splice(0)) await each()
})

describe.skipIf(!playwright)("a video in a browser", () => {
  test(
    "plays, lands a seek on its frame, and holds a pause",
    async () => {
      // Reproduce by serving `__sixb/hyperframes.js` empty (FRAME_ASSETS in frames/assets.ts):
      // no timeline is ever reported, and the run fails waiting for it.
      const port = await getFreePort()
      const origin = `http://localhost:${port}`
      const storage = new InMemoryStorage()
      const blobStorage = new InMemoryBlobStorage()
      const host = new SixbHost({
        id: PROJECT_ID,
        ontology: [],
        broker: new InMemoryBroker(),
        storage,
        lakeStorage: new InMemoryLakeStorage(),
        blobStorage,
        queues: new InMemoryQueues(),
        auth: { id: "test", kind: "dev" as const },
      })
      const app = createSixbApi(
        new SixbServer({
          host,
          quiet: true,
          browser: { publicOrigin: origin, allowedOrigins: [origin] },
        })
      )

      const credential = createSessionCredential("ses_alice")
      await storage.auth.users.create({ id: "alice", projectId: PROJECT_ID, email: "a@acme.com" })
      await storage.auth.sessions.create({
        id: credential.sessionId,
        projectId: PROJECT_ID,
        userId: "alice",
        strategyId: "test",
        tokenHash: credential.tokenHash,
        createdAt: new Date("2026-11-18T10:00:00.000Z"),
        expiresAt: new Date("2099-11-18T10:00:00.000Z"),
      })
      const put = async (path: string, body: string) => ({
        path,
        file: await blobStorage.put({
          body: new TextEncoder().encode(body),
          fileName: path,
          mediaType: "text/html",
        }),
      })
      const published = await app.fetch(
        new Request(`${origin}/api/artifacts`, {
          method: "POST",
          headers: {
            cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=c`,
            "x-sixb-csrf": "c",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            kind: "video",
            title: "Box",
            files: [await put("index.html", INDEX), await put("scenes/move.html", SCENE)],
          }),
        })
      )
      expect(published.status).toBe(201)
      const { artifact } = (await published.json()) as { artifact: { id: string } }

      const artifacts = storage.artifacts
      const version = await artifacts?.getVersion({
        projectId: PROJECT_ID,
        artifactId: artifact.id,
        version: 1,
      })
      if (!artifacts || !version) throw new Error("Expected the video's version.")
      const frame = await createArtifactFrame({
        projectId: PROJECT_ID,
        storage: artifacts,
        version,
      })

      const server = Bun.serve({
        port,
        fetch: (request) =>
          new URL(request.url).pathname === "/player"
            ? new Response(PLAYER(`${origin}${frame.path}index.html`), {
                headers: { "content-type": "text/html" },
              })
            : app.fetch(request),
      })
      cleanup.push(async () => {
        await server.stop(true)
      })

      const directory = await mkdtemp(join(tmpdir(), "sixb-video-playback-"))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      const script = join(directory, "drive.cjs")
      await writeFile(script, DRIVE)

      // The browser runs in a child process with a bound: a wedged one fails this test, alone.
      const child = Bun.spawn(["node", script], {
        env: { ...process.env, SIXB_PLAYWRIGHT: playwright, PLAYER_URL: `${origin}/player` },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), RUN_BOUND_MS)
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      clearTimeout(timer)
      expect(code, errors).toBe(0)

      const seen = JSON.parse(output.trim().split("\n").at(-1) ?? "{}")
      // The frame finds HyperFrames' runtime where it looks for it: a release that moved it would
      // have every video say it cannot start. Reproduce by checking another global than
      // `__hyperframes` in runtime.ts's `ready`: the frame posts `failed`.
      expect(seen.frame).toContain("ready")
      expect(seen.frame).not.toContain("failed")
      // Playing a second moves the box on, about 250px a second.
      expect(seen.played.time).toBeGreaterThan(0.5)
      expect(seen.played.box).toBeGreaterThan(100)
      // A seek lands on its frame: 1.5 s in, the box is 375px along.
      expect(seen.seeked.time).toBe(1.5)
      expect(seen.seeked.box).toBeCloseTo(375, 0)
      // Played on from there, then paused: nothing moves.
      expect(seen.paused.time).toBeGreaterThan(1.5)
      expect(seen.held).toEqual(seen.paused)
    },
    RUN_BOUND_MS + 10_000
  )
})
