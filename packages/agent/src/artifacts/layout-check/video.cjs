// The Agent's check of a published video, run in the sandbox by publish_artifact. A video plays
// rather than lays out, so HyperFrames checks it, the release that renders its export, on the files
// the export renders: the version's HTML as a frame serves it, written into <output>/project by the
// worker, and every other file linked there from where the Agent published it. A recording the
// version keeps in the API is fetched there first: its proxy, or a sound as it is.
//
// Then `hyperframes check` (lint, runtime, layout, motion, contrast, craft, sound); a look at the
// media of the scenes playing at each instant the worker chose, in the root as the app's frame
// plays it, sought there with Playwright; and `hyperframes snapshot` at the instants it chose for
// frames, which writes them and a contact sheet. It writes one line of JSON:
// { layout: "video", findings, sheets, frames, missing, media?, stopped? } or { skipped }.
//
//   node video.cjs <output directory> <deadline in ms>
//
// The output directory holds project/, links.json, the files to link by their path in the version
// and where each is, fetches.json, the `sixb` arguments that fetch each remote recording,
// frame.html, the root with the frame's runtimes, instants.json, the seconds to snapshot with the
// scenes playing at each, and looks.json, the seconds to look at the media, the same way. Beside
// this script are the frame's runtimes, video.js and hyperframes.js, and media.js, the probe. Each
// HyperFrames command runs in a process group of its own, killed with its browser once the
// deadline passes, and the look at the media is bounded: the check then reports what it found.
"use strict"

const { spawn } = require("node:child_process")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")

/**
 * HyperFrames' Chrome runs without a sandbox of its own, as Playwright's does in the layout check:
 * the sandbox the check runs in is the boundary, and a seatbelt, as a local one on macOS, refuses
 * to nest Chrome's, which then takes no frame. It reports usage unless told not to.
 */
Object.assign(process.env, {
  HYPERFRAMES_CHROME_SANDBOX: "0",
  HYPERFRAMES_NO_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
})

const [out, deadline] = process.argv.slice(2)
const DEADLINE_MS = Number(deadline) || 150_000
const started = Date.now()
const left = () => DEADLINE_MS - (Date.now() - started)

/** What `hyperframes check` may take at most: half the time left, and never under its floor. */
const CHECK_BUDGET_MS = { min: 30_000, max: 90_000 }
/** How long past its budget `hyperframes check` is given to report what it found. */
const CHECK_GRACE_MS = 20_000
/** The time the snapshot keeps for itself, whatever the fetches and the check take. */
const SNAPSHOT_RESERVE_MS = 45_000
/** The time a fetch is not worth starting with. */
const FETCH_MIN_MS = 5_000
/** The most the look at the media takes, and the least time it is worth starting with. */
const MEDIA_MS = { min: 8_000, max: 30_000 }

const project = path.join(out, "project")
const read = (name) => JSON.parse(fs.readFileSync(path.join(out, name), "utf8"))

function report(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
}

/**
 * Runs a command in a process group of its own and resolves with what it wrote, killing the whole
 * group, a browser included, after `ms`.
 */
function run(command, args, ms) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))

    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        // Gone already.
      }
    }, Math.max(1_000, ms))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error.message), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

/** The JSON a HyperFrames command printed: its last line that parses, or its whole output. */
function json(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    const line = stdout.trim().split("\n").at(-1)
    try {
      return line ? JSON.parse(line) : null
    } catch {
      return null
    }
  }
}

/**
 * HyperFrames keeps its fonts and frames in its cache, `~/.cache/hyperframes`, and takes no frame
 * when it cannot write there, as in a sandbox whose home is read only: its cache is then the
 * check's library's, as the render worker's video.cjs does.
 */
function hyperframesCache() {
  const cache = process.env.HYPERFRAMES_CACHE_DIR || path.join(os.homedir(), ".cache", "hyperframes")
  // A sandbox may deny what the file's mode allows: only a write says.
  const probe = path.join(cache, `.sixb-${process.pid}`)
  try {
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(probe, "")
    fs.rmSync(probe)
  } catch {
    process.env.HYPERFRAMES_CACHE_DIR = path.join(__dirname, ".hyperframes-cache")
    fs.mkdirSync(process.env.HYPERFRAMES_CACHE_DIR, { recursive: true })
  }
}

/** The grey copy a frame's ink is measured on: small enough to read in a moment, text still sharp. */
const INK = { width: 192, height: 108, step: 24 }

/**
 * How much a frame shows: the share of its neighbouring pixels, on a small grey copy, that differ
 * by more than a step, which text, a product and footage make and a bare ground or a gradient do
 * not. Undefined when FFmpeg cannot read it.
 */
async function inkOf(frame) {
  const { width, height, step } = INK
  const copy = `${frame}.grey`
  const scale = `scale=${width}:${height},format=gray`
  const grey = await run(
    "ffmpeg",
    ["-v", "error", "-y", "-i", frame, "-vf", scale, "-f", "rawvideo", copy],
    10_000
  )
  const pixels = grey.code === 0 && fs.existsSync(copy) ? fs.readFileSync(copy) : undefined
  fs.rmSync(copy, { force: true })
  if (pixels?.length !== width * height) return undefined

  let edges = 0
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const at = pixels[y * width + x]
      const right = pixels[y * width + x + 1]
      const below = pixels[(y + 1) * width + x]
      if (Math.abs(at - right) > step || Math.abs(at - below) > step) edges++
    }
  }
  return edges / ((width - 1) * (height - 1))
}

/** What the look at the media serves, by extension; anything else is served as bytes. */
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

/**
 * Serves the project as the app's frame does: the root with the frame's runtimes, which are beside
 * this script, and every other file, ranges included, from the project.
 */
function serveFrame() {
  const frame = path.join(out, "frame.html")
  const runtimes = {
    "/__sixb/video.js": path.join(__dirname, "video.js"),
    "/__sixb/hyperframes.js": path.join(__dirname, "hyperframes.js"),
  }
  const server = http.createServer((request, response) => {
    let pathname = ""
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://frame").pathname)
    } catch {
      // Served as nothing.
    }
    const file =
      pathname === "/" || pathname === "/index.html"
        ? frame
        : (runtimes[pathname] ?? path.join(project, pathname))
    const served =
      file === frame ||
      Object.values(runtimes).includes(file) ||
      !path.relative(project, file).startsWith("..")

    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile() || !served) {
        response.writeHead(404)
        response.end()
        return
      }

      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "")
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
      if (range && start > end) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
        response.end()
        return
      }

      response.writeHead(range ? 206 : 200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(Math.max(0, end - start + 1)),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
      })
      if (stat.size === 0) response.end()
      else fs.createReadStream(file, { start, end }).pipe(response)
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

function loadPlaywright() {
  for (const candidate of [process.env.SIXB_PLAYWRIGHT, "/opt/sixb/js/node_modules/playwright"]) {
    if (!candidate) continue
    try {
      return require(candidate)
    } catch {
      // The next candidate, then none.
    }
  }
  return null
}

/**
 * What the scenes playing at each instant show of their media, as the probe sees them: the root is
 * opened as the app's frame plays it, sought to each instant with HyperFrames' player, and probed
 * there; past `ms`, the instants looked at so far. Undefined when that cannot be told: no
 * Playwright, no frame, a page that does not start, or a script that fails to load, such as GSAP
 * in a sandbox without the CDNs, where what brings media in would not run, here only.
 */
async function mediaSights(instants, ms) {
  if (ms < MEDIA_MS.min || !fs.existsSync(path.join(out, "frame.html"))) return undefined
  const playwright = loadPlaywright()
  if (!playwright) return undefined
  const probe = fs.readFileSync(path.join(__dirname, "media.js"), "utf8")

  let server
  let browser
  let timer
  let over = false
  let started = false
  let failed = false
  const samples = []
  // A page that never yields keeps its browser busy: node's exit takes it with it.
  const close = () => {
    server?.close()
    return Promise.race([browser?.close(), new Promise((resolve) => setTimeout(resolve, 2_000))])
  }

  const look = async () => {
    server = await serveFrame()
    browser = await playwright.chromium.launch({
      headless: true,
      ...(process.env.SIXB_CHROMIUM ? { executablePath: process.env.SIXB_CHROMIUM } : {}),
    })
    // Launched once the time ran out.
    if (over) {
      await close()
      return undefined
    }
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    page.on("requestfailed", (request) => {
      if (request.resourceType() === "script") failed = true
    })
    page.on("response", (answer) => {
      if (answer.request().resourceType() === "script" && answer.status() >= 400) failed = true
    })

    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" })
    await page.waitForFunction(() => {
      const player = window.__player
      return typeof window.__hfStartupError === "string" || typeof player?.seek === "function"
    })
    started = await page.evaluate(() => typeof window.__hfStartupError !== "string")
    if (!started || failed) return undefined

    const size = await page.evaluate(() => {
      const root = document.querySelector("[data-composition-id]")
      return {
        width: Number(root?.getAttribute("data-width")) || 1920,
        height: Number(root?.getAttribute("data-height")) || 1080,
      }
    })
    await page.setViewportSize(size)

    for (const { at, scenes } of instants) {
      if (over) break
      if (scenes.length === 0) continue
      await page.evaluate((time) => {
        const player = window.__player
        if (typeof player.renderSeek === "function") player.renderSeek(time, { exact: true })
        else player.seek(time)
        window.gsap?.ticker?.tick()
      }, at)
      // What the seek set is laid out by the next frame; a page that draws none moves on.
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 100)
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          })
      )
      samples.push({ time: at, sights: await page.evaluate(`${probe}(${JSON.stringify(scenes)})`) })
    }
    return failed ? undefined : samples
  }

  try {
    return await Promise.race([
      // A look cut short by the time fails once its browser closes, which nothing waits for.
      look().catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(started && !failed ? [...samples] : undefined), ms)
      }),
    ])
  } catch {
    return undefined
  } finally {
    over = true
    clearTimeout(timer)
    await close()
  }
}

/** The last words a failed command wrote, for the report. */
const tail = (text) => text.trim().split("\n").slice(-3).join(" ").slice(0, 300)

async function main() {
  const hyperframes = await run("bash", ["-lc", "command -v hyperframes"], 10_000)
  if (hyperframes.code !== 0) return report({ skipped: "no_hyperframes" })
  hyperframesCache()

  // The version's other files, where the Agent published them.
  for (const [file, source] of Object.entries(read("links.json"))) {
    const target = path.join(project, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.rmSync(target, { force: true })
    fs.symlinkSync(source, target)
  }

  // The recordings the version keeps in the API: a proxy plays as its original does.
  const missing = []
  const sixb = path.join(process.env.SIXB_BIN_DIR ?? "", "sixb")
  // They leave the check and the snapshot their time: one that would not is left out.
  for (const { path: file, args } of read("fetches.json")) {
    const ms = Math.min(60_000, left() - SNAPSHOT_RESERVE_MS - CHECK_BUDGET_MS.min - CHECK_GRACE_MS)
    if (ms < FETCH_MIN_MS) {
      missing.push({ path: file, why: "the check had no time left to fetch it" })
      continue
    }

    const target = path.join(project, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const fetched = await run(sixb, [...args, "--output", target], ms)
    if (fetched.code !== 0) missing.push({ path: file, why: tail(fetched.stderr) || "it did not arrive" })
  }

  const findings = []
  let stopped
  // HyperFrames takes no budget under its floor, which the fetches left time for.
  const spare = left() - SNAPSHOT_RESERVE_MS - CHECK_GRACE_MS
  const budget = Math.max(CHECK_BUDGET_MS.min, Math.min(CHECK_BUDGET_MS.max, left() / 2, spare))
  const checked = await run(
    "hyperframes",
    ["check", "--json", `--budget=${Math.floor(budget / 1000)}s`, project],
    budget + CHECK_GRACE_MS
  )
  const check = json(checked.stdout)
  if (check) {
    for (const pass of ["lint", "runtime", "layout", "motion", "contrast", "craft", "audio"]) {
      for (const finding of check[pass]?.findings ?? []) findings.push({ ...finding, pass })
    }
  } else {
    stopped = checked.timedOut
      ? "hyperframes check took too long"
      : `hyperframes check failed: ${tail(checked.stderr)}`
  }

  const instants = read("instants.json")
  // It leaves the snapshot its time.
  const media = await mediaSights(
    read("looks.json"),
    Math.min(MEDIA_MS.max, left() - SNAPSHOT_RESERVE_MS)
  )

  // A browser that starts badly, such as one racing another for the machine, takes no frame: the
  // snapshot is taken again once while there is time for it.
  const frames = path.join(out, "frames")
  const at = instants.map((instant) => instant.at).join(",")
  const snap = () =>
    run(
      "hyperframes",
      ["snapshot", `--at=${at}`, "--no-end", "--json", `--output=${frames}`, project],
      left() - 2_000
    )
  let snapshot = await snap()
  let snapped = json(snapshot.stdout)
  if (!snapped?.frames?.length && !snapshot.timedOut && left() > 30_000) {
    snapshot = await snap()
    snapped = json(snapshot.stdout)
  }
  if (!snapped?.frames?.length) {
    stopped ??= snapshot.timedOut
      ? "hyperframes snapshot took too long"
      : `hyperframes snapshot took no frame: ${tail(snapshot.stderr) || "it gave no reason"}`
  }

  // How much each frame shows, while there is time: a frame left unmeasured is not judged.
  const measured = []
  for (const frame of snapped?.frames ?? []) {
    const ink = left() > 5_000 ? await inkOf(frame.path) : undefined
    measured.push({ path: frame.path, time: frame.time, ...(ink === undefined ? {} : { ink }) })
  }

  report({
    layout: "video",
    findings,
    sheets: snapped?.contactSheets ?? [],
    frames: measured,
    missing,
    ...(media ? { media } : {}),
    ...(stopped ? { stopped } : {}),
  })
}

main().catch((error) => report({ failed: String(error?.stack ?? error) }))
