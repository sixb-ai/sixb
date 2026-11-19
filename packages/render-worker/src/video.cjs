// What a video's export runs in a sandbox, with the image's HyperFrames and FFmpeg. One mode a run:
//
//   node video.cjs segment <project> <out.mp4> <budget ms> <engine> <fps> <crf> <keyframe s> <workers> <from> <to>
//     Renders frames <from> up to <to> of the project, silent, H.264 at the settings given, its
//     index first: the whole project when <from> is 0, HyperFrames' fast path, a range of it else.
//   node video.cjs sound <project> <out.m4a> <budget ms> <engine> <fps> <frames>
//     Mixes the whole project's sound once, as HyperFrames' own render mixes it, through the plan
//     its distributed render makes: AAC. A project with no sound gets silence, as long as it.
//   node video.cjs assemble <out.mp4> <budget ms> <frames> <fps> <sound> <segment>...
//     Joins the segments in order without encoding them again, with the sound, its index first.
//   node video.cjs stills <project> <out dir> <budget ms> <engine> <width> <second>[,<second>]...
//     Snapshots the project at each moment, as JPEGs at most <width> pixels wide.
//
// The report is { status: "ready", path, bytes, ... }, { stills: [...] }, { skipped } when the
// sandbox lacks a tool or runs another HyperFrames, or { failed } with why.

const { spawn } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { report } = require("./shared.cjs")

/** Kept for the report to end in, once the budget is spent. */
const MARGIN_MS = 5000
const STDERR_BYTES = 4096
/** HyperFrames' low-memory profile renders by screenshots with one browser, twice slower. */
const ENOUGH_MEMORY = 3 * 1024 ** 3

/** HyperFrames reports usage unless told not to; `hyperframesCache` adds where it may write. */
const ENV = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" }

const [mode, ...args] = process.argv.slice(2)

report(async () => {
  const deadline = Date.now() + Number(args[2]) - MARGIN_MS
  const left = () => Math.max(1000, deadline - Date.now())

  if (!(await available("ffmpeg")) || !(await available("ffprobe"))) return { skipped: "no_ffmpeg" }
  if (mode === "assemble") return assemble(left)

  if (!(await available("hyperframes"))) return { skipped: "no_hyperframes" }
  await hyperframesCache()
  const engine = await hyperframesVersion()
  if (engine !== args[3]) return { skipped: "engine", engine: engine ?? "unknown" }

  if (mode === "segment") return segment(left)
  if (mode === "sound") return sound(left)
  if (mode === "stills") return stills(left)
  return { failed: `no such mode '${mode}'` }
})

async function segment(left) {
  const [project, out, , , fps, crf, keyframe, workers, from, to] = args
  const raw = `${out}.raw.mp4`
  const range =
    Number(from) > 0 ? ["--start", seconds(from, fps), "--end", seconds(to, fps)] : []

  const rendered = await execute(
    "hyperframes",
    [
      "render",
      project,
      "--quiet",
      ...["--format", "mp4", "--sdr", "--fps", fps, "--crf", crf],
      ...["--keyframe-interval", keyframe, "--workers", workers],
      ...(enoughMemory() ? ["--no-low-memory-mode"] : []),
      ...range,
      ...["-o", raw],
    ],
    { timeoutMs: left() }
  )
  if (rendered.failed) return { failed: `HyperFrames: ${rendered.failed}` }

  // Silent, and its index first: the export mixes the sound, and joins segments as they are. A
  // whole render and a range keep time in different units (1/15360 and 1/90000 at 30 fps), which
  // the join would read as the first one's: every segment keeps it in 90000ths of a second, a
  // whole number of them a frame at every rate a video plays at.
  const kept = await execute(
    "ffmpeg",
    [
      ...["-v", "error", "-y", "-i", raw, "-map", "0:v:0", "-c", "copy"],
      ...["-video_track_timescale", "90000", "-movflags", "+faststart", out],
    ],
    { timeoutMs: left() }
  )
  fs.rmSync(raw, { force: true })
  if (kept.failed) return { failed: `FFmpeg: ${kept.failed}` }

  const frames = await countFrames(out, left)
  const wanted = Number(to) - Number(from)
  if (frames !== wanted) return { failed: `it holds ${frames} frames, not ${wanted}` }
  return ready(out, "video/mp4", { frames })
}

async function sound(left) {
  const [project, out, , , fps, frames] = args
  const producer = await hyperframesProducer()
  if (typeof producer === "string") return { skipped: "no_producer", detail: producer }

  // The plan HyperFrames' distributed render makes mixes the whole film's sound once, as a render
  // mixes it, and captures no frame: its `audio.m4a` is what a render of the film plays.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sixb-sound-"))
  try {
    const engineConfig = producer.resolveConfig({ browserGpuMode: "software" })
    const request = producer.createRenderRequest({
      projectDir: path.resolve(project),
      outputPath: out,
      engineConfig,
      options: {
        fps: { num: Number(fps), den: 1 },
        quality: "standard",
        format: "mp4",
        // The plan reads the film's own size; this only fills the request.
        distributed: { width: 1920, height: 1080 },
      },
    })
    const config = producer.distributedConfigFromRequest(request, {})
    const planDir = path.join(work, "plan")
    const planned = await within(producer.planV2(path.resolve(project), config, planDir), left())

    // What the plan is read by: its manifest, and its artifacts stored by their SHA-256.
    const manifest =
      typeof planned?.manifestPath === "string" && fs.existsSync(planned.manifestPath)
        ? JSON.parse(fs.readFileSync(planned.manifestPath, "utf8"))
        : null
    if (!Array.isArray(manifest?.artifacts)) {
      return { skipped: "no_producer", detail: "planV2 wrote no manifest of artifacts" }
    }
    const audio = manifest.artifacts.find((artifact) => artifact.path === "audio.m4a")
    if (audio) {
      const stored = path.join(planDir, "artifacts", "sha256", String(audio.sha256).slice(0, 2), String(audio.sha256))
      if (!fs.existsSync(stored)) {
        return { skipped: "no_producer", detail: "planV2's audio.m4a is not where its manifest says" }
      }
      fs.copyFileSync(stored, out)
      return ready(out, "audio/mp4", {})
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }

  // Nothing sounds: silence as long as the film, so every export plays a sound track.
  const silent = await execute(
    "ffmpeg",
    [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"],
      ...["-t", seconds(frames, fps), "-c:a", "aac", "-b:a", "192k", "-f", "mp4", out],
    ],
    { timeoutMs: left() }
  )
  if (silent.failed) return { failed: `FFmpeg: ${silent.failed}` }
  return ready(out, "audio/mp4", { silent: true })
}

async function assemble(left) {
  const [out, , frames, fps, soundtrack, ...segments] = args
  const list = `${out}.txt`
  fs.writeFileSync(list, segments.map((segment) => `file '${segment.replaceAll("'", "'\\''")}'\n`).join(""))

  const joined = await execute(
    "ffmpeg",
    [
      ...["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", soundtrack],
      ...["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", out],
    ],
    { timeoutMs: left() }
  )
  if (joined.failed) return { failed: `FFmpeg: ${joined.failed}` }

  const counted = await countFrames(out, left)
  if (counted !== Number(frames)) return { failed: `it holds ${counted} frames, not ${frames}` }

  // Every frame where it plays: segments joined at the wrong time play a frozen frame.
  const lasts = await videoDuration(out, left)
  const length = Number(frames) / Number(fps)
  if (!(Math.abs(lasts - length) * Number(fps) < 1)) {
    return { failed: `it plays ${lasts} seconds, not ${length}` }
  }
  return ready(out, "video/mp4", { frames: counted })
}

async function stills(left) {
  const [project, outDir, , , width, at] = args
  const raw = path.join(outDir, "raw")
  fs.mkdirSync(raw, { recursive: true })

  const snapshot = await execute(
    "hyperframes",
    ["snapshot", project, "--at", at, "--no-end", "--keep", "-o", raw, "--json"],
    { timeoutMs: left(), stdout: true }
  )
  if (snapshot.failed) return { failed: `HyperFrames: ${snapshot.failed}` }

  let frames
  try {
    frames = JSON.parse(snapshot.stdout.toString("utf8")).frames
  } catch {
    return { failed: "HyperFrames reported no stills" }
  }

  const made = []
  for (const [index, frame] of frames.entries()) {
    const out = path.join(outDir, `still-${index}.jpg`)
    const scaled = await execute(
      "ffmpeg",
      [
        ...["-v", "error", "-y", "-i", frame.path],
        ...["-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", "-frames:v", "1", out],
      ],
      { timeoutMs: left() }
    )
    if (scaled.failed) return { failed: `FFmpeg: ${scaled.failed}` }
    made.push({ path: out, bytes: fs.statSync(out).size, at: frame.time })
  }
  return { stills: made }
}

/** What the sound needs of HyperFrames' producer, its distributed render's own functions. */
const PRODUCER = ["planV2", "resolveConfig", "createRenderRequest", "distributedConfigFromRequest"]

/**
 * HyperFrames' producer, as the CLI bundles it: the module of its `dist` that exports what
 * `PRODUCER` names. No package export reaches it, so it is found by what it exports, only in the
 * one HyperFrames every key names; else why not, naming what is missing.
 */
async function hyperframesProducer() {
  const cli = await execute("bash", ["-c", "readlink -f \"$(command -v hyperframes)\""], {
    timeoutMs: 10_000,
    stdout: true,
  })
  if (cli.failed) return "the hyperframes command resolves to no file"
  const dist = path.resolve(path.dirname(cli.stdout.toString("utf8").trim()), "..", "dist")
  if (!fs.existsSync(dist)) return `${dist} does not exist`

  for (const name of fs.readdirSync(dist)) {
    if (!/^src-.*\.js$/.test(name)) continue
    const text = fs.readFileSync(path.join(dist, name), "utf8")
    if (!PRODUCER.every((each) => new RegExp(`\\b${each},\\n`).test(text))) continue

    const producer = await import(pathToFileURL(path.join(dist, name)).href)
    const missing = PRODUCER.filter((each) => typeof producer[each] !== "function")
    if (missing.length === 0) return producer
    return `${name} exports no function ${missing.join(", ")}`
  }
  return `no module of ${dist} exports ${PRODUCER.join(", ")}`
}

/**
 * HyperFrames keeps its history, fonts and frames in its cache, `~/.cache/hyperframes`, beside the
 * browser it renders with, and stops when it cannot write there, as in a sandbox whose home is read
 * only. Then it writes in the sandbox's working directory instead, its browser found where it is.
 */
async function hyperframesCache() {
  const cache = process.env.HYPERFRAMES_CACHE_DIR || path.join(os.homedir(), ".cache", "hyperframes")
  if (writable(cache)) return

  if (!ENV.HYPERFRAMES_BROWSER_PATH) {
    const browser = await execute("hyperframes", ["browser", "path"], { timeoutMs: 30_000, stdout: true })
    const found = browser.failed ? "" : browser.stdout.toString("utf8").trim().split("\n").at(-1)
    if (found && fs.existsSync(found)) ENV.HYPERFRAMES_BROWSER_PATH = found
  }
  ENV.HYPERFRAMES_CACHE_DIR = path.join(__dirname, ".hyperframes-cache")
  fs.mkdirSync(ENV.HYPERFRAMES_CACHE_DIR, { recursive: true })
}

function writable(dir) {
  const probe = path.join(dir, `.sixb-${process.pid}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(probe, "")
    fs.rmSync(probe)
    return true
  } catch {
    return false
  }
}

async function hyperframesVersion() {
  const run = await execute("hyperframes", ["--version"], { timeoutMs: 30_000, stdout: true })
  const version = run.failed ? "" : run.stdout.toString("utf8").trim()
  return /^\d+\.\d+\.\d+/.test(version) ? `hyperframes@${version}` : null
}

/** Whether the sandbox holds enough memory for HyperFrames' fast capture, its cgroup's limit first. */
function enoughMemory() {
  let limit = os.totalmem()
  try {
    const max = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()
    if (/^\d+$/.test(max)) limit = Math.min(limit, Number(max))
  } catch {
    // No cgroup limit: the machine's memory.
  }
  return limit >= ENOUGH_MEMORY
}

async function countFrames(file, left) {
  const run = await execute(
    "ffprobe",
    [
      ...["-v", "error", "-select_streams", "v:0", "-count_packets"],
      ...["-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file],
    ],
    { timeoutMs: left(), stdout: true }
  )
  return run.failed ? -1 : Number(run.stdout.toString("utf8").trim())
}

/** How long a file's picture plays, in seconds, from its first frame's start to its last's end. */
async function videoDuration(file, left) {
  const run = await execute(
    "ffprobe",
    [...["-v", "error", "-select_streams", "v:0"], ...["-show_entries", "stream=duration", "-of", "csv=p=0", file]],
    { timeoutMs: left(), stdout: true }
  )
  return run.failed ? Number.NaN : Number(run.stdout.toString("utf8").trim())
}

function ready(file, mediaType, fields) {
  return { status: "ready", path: file, bytes: fs.statSync(file).size, mediaType, ...fields }
}

/** Frames as seconds, as HyperFrames reads them back to the same frame. */
function seconds(frames, fps) {
  return String(Number((Number(frames) / Number(fps)).toFixed(9)))
}

function within(promise, ms) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`it took more than ${Math.round(ms / 1000)} seconds`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function available(tool) {
  const run = await execute("bash", ["-c", `command -v ${tool}`], { timeoutMs: 10_000 })
  return !run.failed
}

/** Runs a tool, killed past `timeoutMs`: its stdout when asked, or why it failed. */
function execute(tool, toolArgs, options) {
  return new Promise((resolve) => {
    const child = spawn(tool, toolArgs, { env: ENV, stdio: ["ignore", "pipe", "pipe"] })
    const out = []
    let err = ""
    child.stdout.on("data", (chunk) => {
      if (options.stdout) out.push(chunk)
    })
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString("utf8")).slice(-STDERR_BYTES)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ failed: String(error.message) })
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: Buffer.concat(out) })
      else resolve({ failed: signal ? `stopped by ${signal}` : `exit ${code}: ${err.trim()}` })
    })
  })
}
