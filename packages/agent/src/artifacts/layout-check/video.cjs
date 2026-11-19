// The Agent's check of a published video, run in the sandbox by publish_artifact. A video plays
// rather than lays out, so HyperFrames checks it, the release that renders its export, on the files
// the export renders: the version's HTML as a frame serves it, written into <output>/project by the
// worker, and every other file linked there from where the Agent published it. A recording the
// version keeps in the API is fetched there first: its proxy, or a sound as it is.
//
// Then `hyperframes check` (lint, runtime, layout, motion, contrast, craft, sound) and
// `hyperframes snapshot` at the instants the worker chose, which writes the frames and a contact
// sheet. It writes one line of JSON:
// { layout: "video", findings, sheets, frames, missing, stopped? } or { skipped }.
//
//   node video.cjs <output directory> <deadline in ms>
//
// The output directory holds project/, links.json, the files to link by their path in the version
// and where each is, fetches.json, the `sixb` arguments that fetch each remote recording, and
// instants.json, the seconds to snapshot. Each HyperFrames command runs in a process group of its
// own, killed with its browser once the deadline passes: the check then reports what it found.
"use strict"

const { spawn } = require("node:child_process")
const fs = require("node:fs")
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

  // A browser that starts badly, such as one racing another for the machine, takes no frame: the
  // snapshot is taken again once while there is time for it.
  const instants = read("instants.json")
  const frames = path.join(out, "frames")
  const snap = () =>
    run(
      "hyperframes",
      ["snapshot", `--at=${instants.join(",")}`, "--no-end", "--json", `--output=${frames}`, project],
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
    ...(stopped ? { stopped } : {}),
  })
}

main().catch((error) => report({ failed: String(error?.stack ?? error) }))
