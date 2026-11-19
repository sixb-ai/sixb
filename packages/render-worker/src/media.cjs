// What Sixb derives from a video or a sound, in a sandbox, with the image's FFmpeg: what the file
// holds, a light proxy that plays and scrubs, a poster, a filmstrip, the sound's peaks, where the
// picture cuts, and the sound for the transcription model. Each part is made on its own, so one
// that fails costs only itself; each FFmpeg run is bounded by the media's length.
//
//   node media.cjs <original> <out dir> <budget ms> <max duration ms> <proxy ms> <part>[,<part>]...
//
// Parts: proxy, poster, filmstrip, waveform, cuts, audio; none probes alone, which says how long
// the rest may take. The probe always runs. The proxy takes at most <proxy ms>, which the worker
// scales by the pixels it decodes; every other step is bounded by the media's length. The report is
// { parts: { probe, <part>: { status, ... } } }, or { skipped: "no_ffmpeg" }.

const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const { report } = require("./shared.cjs")

/** The poster's and the proxy's shorter side, at most. */
const SHORT_SIDE = 720
/** A proxy plays at most this many frames a second. */
const MAX_FPS = 30
/** A keyframe every half second, so the proxy seeks to any moment at once. */
const KEYFRAME_SECONDS = 0.5
const FILMSTRIP_HEIGHT = 90
const FILMSTRIP_COLUMNS = 10
const FILMSTRIP_MAX_COUNT = 120
/** The filmstrip's intervals, in seconds: the first that keeps it within its count. */
const FILMSTRIP_INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120]
const PEAKS_PER_SECOND = 50
const PEAK_SAMPLE_RATE = 8000
/** How much the picture changes, from 0 to 1, for FFmpeg to call it a cut. */
const CUT_SCENE_SCORE = 0.3
const MAX_CUTS = 1000
/** How far apart two cuts are at least: closer ones are a flash, not a new shot. */
const MIN_SHOT_MS = 500
/** Kept for the report to end in, once the budget is spent. */
const MARGIN_MS = 5000
const STDERR_BYTES = 4096

/** Containers and codecs every browser plays, by FFmpeg's names. */
const PLAYABLE_SOUNDS = [
  { container: /(^|,)mp3(,|$)/, codecs: ["mp3"] },
  { container: /(^|,)(mov|mp4|m4a)(,|$)/, codecs: ["aac", "mp3"] },
  { container: /(^|,)aac(,|$)/, codecs: ["aac"] },
  { container: /(^|,)ogg(,|$)/, codecs: ["opus", "vorbis", "flac"] },
  { container: /(^|,)webm(,|$)/, codecs: ["opus", "vorbis"] },
  { container: /(^|,)wav(,|$)/, codecs: ["pcm_s16le", "pcm_u8", "pcm_s24le", "pcm_f32le"] },
  { container: /(^|,)flac(,|$)/, codecs: ["flac"] },
]

const [original, out, budget, maxDuration, proxyBudget, wanted] = process.argv.slice(2)
const deadline = Date.now() + Number(budget) - MARGIN_MS
const parts = new Set(String(wanted ?? "").split(",").filter(Boolean))

report(async () => {
  if (!(await available("ffprobe")) || !(await available("ffmpeg"))) return { skipped: "no_ffmpeg" }
  fs.mkdirSync(out, { recursive: true })

  const probed = await probe(original)
  if (probed.status !== "ready") return { parts: { probe: probed, ...each(() => probed) } }

  // Past the longest media Sixb derives, what it holds is all it says.
  if (probed.durationMs > Number(maxDuration)) {
    const minutes = Math.round(Number(maxDuration) / 60_000)
    const reason = `It is longer than ${minutes} minutes.`
    return { parts: { probe: probed, ...each(() => ({ status: "unavailable", reason })) } }
  }

  const derived = { probe: probed }
  const { video, audio, durationMs } = probed
  const noPicture = { status: "unavailable", reason: "It has no picture." }
  const noSound = { status: "unavailable", reason: "It has no sound." }

  if (parts.has("proxy")) derived.proxy = await proxy(probed)
  // The pictures come from the proxy when there is one: it is small, and seeks at once.
  const pictures = derived.proxy?.status === "ready" && video ? derived.proxy.path : original

  if (parts.has("poster")) derived.poster = video ? await poster(pictures, durationMs) : noPicture
  if (parts.has("filmstrip")) {
    derived.filmstrip = video ? await filmstrip(pictures, probed, pictures !== original) : noPicture
  }
  if (parts.has("cuts")) derived.cuts = video ? await cuts(pictures, durationMs) : noPicture
  if (parts.has("waveform")) derived.waveform = audio ? await waveform(durationMs) : noSound
  if (parts.has("audio")) derived.audio = audio ? await speech(durationMs) : noSound
  return { parts: derived }
})

/** Each wanted part, as `make` says. */
function each(make) {
  return Object.fromEntries([...parts].map((name) => [name, make(name)]))
}

/** What the file holds, as ffprobe reads it. */
async function probe(file) {
  const run = await execute(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    { timeoutMs: 60_000, stdout: true }
  )
  const unreadable = { status: "failed", reason: "It could not be read as a video or a sound." }
  if (run.failed) return { ...unreadable, detail: run.failed }

  let read
  try {
    read = JSON.parse(run.stdout.toString("utf8"))
  } catch {
    return unreadable
  }
  const format = read.format ?? {}
  const streams = read.streams ?? []
  // A sound's cover art is a picture stream too, but no video.
  const video = streams.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic
  )
  const audio = streams.find((stream) => stream.codec_type === "audio")
  const seconds = Number(format.duration ?? video?.duration ?? audio?.duration)
  if ((!video && !audio) || !(seconds >= 0)) return unreadable

  const container = String(format.format_name ?? "")
  const bitRate = Math.round(Number(format.bit_rate))
  const faststart = /(^|,)(mov|mp4)(,|$)/.test(container) ? indexFirst(file) : undefined
  return {
    status: "ready",
    durationMs: Math.round(seconds * 1000),
    container,
    ...(bitRate > 0 ? { bitRate } : {}),
    ...(faststart === undefined ? {} : { faststart }),
    ...(video ? { video: picture(video) } : {}),
    ...(audio ? { audio: sound(audio) } : {}),
  }
}

/** A video stream as it shows: turned by its rotation, at its frame rate. */
function picture(stream) {
  const turned = (side) => side?.rotation
  const matrix = (stream.side_data_list ?? []).map(turned).find((value) => value !== undefined)
  // The display matrix turns counterclockwise; the older tag says clockwise.
  const clockwise = matrix !== undefined ? -Number(matrix) : Number(stream.tags?.rotate ?? 0)
  const rotation = (((Math.round(clockwise) % 360) + 360) % 360) || 0
  const sideways = rotation === 90 || rotation === 270
  const fps = rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate)
  return {
    codec: String(stream.codec_name ?? "unknown"),
    width: sideways ? stream.height : stream.width,
    height: sideways ? stream.width : stream.height,
    rotation,
    ...(fps ? { fps } : {}),
  }
}

function sound(stream) {
  const sampleRate = Number(stream.sample_rate)
  const channels = Number(stream.channels)
  return {
    codec: String(stream.codec_name ?? "unknown"),
    ...(sampleRate > 0 ? { sampleRate } : {}),
    ...(channels > 0 ? { channels } : {}),
  }
}

/** `30000/1001` as 29.97; undefined for FFmpeg's `0/0`. */
function rate(value) {
  const [numerator, denominator] = String(value ?? "").split("/").map(Number)
  const fps = denominator ? numerator / denominator : numerator
  return fps > 0 && Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : undefined
}

/** Whether an MP4's index, its `moov` box, comes before its data, its `mdat` box. */
function indexFirst(file) {
  const handle = fs.openSync(file, "r")
  try {
    const header = Buffer.alloc(16)
    for (let at = 0, boxes = 0; boxes < 64; boxes += 1) {
      if (fs.readSync(handle, header, 0, 16, at) < 8) return undefined
      const type = header.toString("latin1", 4, 8)
      if (type === "moov") return true
      if (type === "mdat") return false
      const size = header.readUInt32BE(0)
      const length = size === 1 ? Number(header.readBigUInt64BE(8)) : size
      if (length < 8) return undefined
      at += length
    }
    return undefined
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * What plays in the original's place. A video: H.264 with its shorter side at most 720 pixels,
 * even sides, at most 30 frames a second, a keyframe every half second, AAC, its index first. A
 * sound: AAC, only when browsers cannot play the original.
 */
async function proxy(probed) {
  const { video, audio, container } = probed
  const budgetMs = Number(proxyBudget)

  if (!video) {
    const playable = PLAYABLE_SOUNDS.some(
      (sound) => sound.container.test(container) && sound.codecs.includes(audio.codec)
    )
    if (playable) return { status: "unavailable", reason: "It plays as it is." }

    const file = path.join(out, "proxy.m4a")
    const sound = ["-vn", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", file]
    return made(await execute("ffmpeg", ["-i", original, ...sound], { timeoutMs: budgetMs }), {
      path: file,
      mediaType: "audio/mp4",
    })
  }

  // The picture as it shows, square pixels, then its shorter side down to 720 at most.
  const landscape = video.width >= video.height
  const short = `trunc(min(${SHORT_SIDE},${landscape ? "ih" : "iw"})/2)*2`
  const filters = [
    ...(video.fps > MAX_FPS + 0.5 ? [`fps=${MAX_FPS}`] : []),
    "scale=trunc(iw*sar/2)*2:ih,setsar=1",
    landscape ? `scale=-2:'${short}'` : `scale='${short}':-2`,
    "format=yuv420p",
  ]
  const file = path.join(out, "proxy.mp4")
  const args = [
    ...["-i", original, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"],
    ...["-vf", filters.join(",")],
    ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high"],
    ...["-maxrate", "4M", "-bufsize", "8M"],
    ...["-force_key_frames", `expr:gte(t,n_forced*${KEYFRAME_SECONDS})`],
    ...(audio ? ["-c:a", "aac", "-b:a", "128k", "-ac", "2"] : []),
    ...["-movflags", "+faststart", file],
  ]
  return made(await execute("ffmpeg", args, { timeoutMs: budgetMs }), {
    path: file,
    mediaType: "video/mp4",
  })
}

/**
 * A JPEG of the first moment from one second on that is neither near-black nor flat: a fade in
 * or a title card's backdrop says little of a video. The moment with the most detail otherwise.
 */
async function poster(source, durationMs) {
  // A share of a short clip may come before one second: it is looked at from one second on.
  const moments = [1000, 0.1, 0.25, 0.5, 0.75]
    .map((at) => (at < 1 ? Math.max(1000, Math.round(durationMs * at)) : at))
    .filter((at) => at < durationMs)
  if (moments.length === 0) moments.push(Math.floor(durationMs / 2))

  let chosen = { atMs: moments[0], detail: -1 }
  for (const atMs of [...new Set(moments)].sort((left, right) => left - right)) {
    const look = await execute(
      "ffmpeg",
      [
        ...["-ss", seconds(atMs), "-i", source, "-frames:v", "1"],
        ...["-vf", "scale=64:36,format=gray", "-f", "rawvideo", "-"],
      ],
      { timeoutMs: 30_000, stdout: true }
    )
    if (look.failed || look.stdout.length === 0) continue

    const { mean, deviation } = brightness(look.stdout)
    if (deviation > chosen.detail) chosen = { atMs, detail: deviation }
    if (mean >= 24 && deviation >= 8) break
  }

  const file = path.join(out, "poster.jpg")
  const short = `trunc(min(${SHORT_SIDE},min(iw,ih))/2)*2`
  const run = await execute(
    "ffmpeg",
    [
      ...["-ss", seconds(chosen.atMs), "-i", source, "-frames:v", "1"],
      ...["-vf", `scale='if(gte(iw,ih),-2,${short})':'if(gte(iw,ih),${short},-2)'`],
      ...["-q:v", "3", file],
    ],
    { timeoutMs: 60_000 }
  )
  return made(run, { path: file, mediaType: "image/jpeg", atMs: chosen.atMs })
}

/** The mean and the spread of a gray picture's bytes, from 0 to 255. */
function brightness(bytes) {
  let sum = 0
  for (const byte of bytes) sum += byte
  const mean = sum / bytes.length
  let spread = 0
  for (const byte of bytes) spread += (byte - mean) ** 2
  return { mean, deviation: Math.sqrt(spread / bytes.length) }
}

/**
 * Thumbnails 90 pixels high at a regular interval, 10 to a row of one JPEG. From the proxy, only
 * its keyframes are decoded: there is one every half second.
 */
async function filmstrip(source, probed, keyframes) {
  const { durationMs, video } = probed
  const intervalMs =
    1000 *
    (FILMSTRIP_INTERVALS.find((step) => durationMs / (step * 1000) <= FILMSTRIP_MAX_COUNT) ??
      FILMSTRIP_INTERVALS.at(-1))
  const count = Math.max(1, Math.min(FILMSTRIP_MAX_COUNT, Math.ceil(durationMs / intervalMs)))
  const columns = Math.min(FILMSTRIP_COLUMNS, count)
  const rows = Math.ceil(count / columns)
  const width = Math.max(2, Math.round((FILMSTRIP_HEIGHT * video.width) / video.height / 2) * 2)

  const file = path.join(out, "filmstrip.jpg")
  const run = await execute(
    "ffmpeg",
    [
      ...(keyframes ? ["-skip_frame", "nokey"] : []),
      ...["-i", source, "-an", "-frames:v", "1"],
      ...[
        "-vf",
        `fps=1000/${intervalMs},scale=${width}:${FILMSTRIP_HEIGHT},setsar=1,tile=${columns}x${rows}`,
      ],
      ...["-q:v", "5", file],
    ],
    { timeoutMs: 60_000 + durationMs / 5 }
  )
  return made(run, {
    path: file,
    mediaType: "image/jpeg",
    intervalMs,
    count,
    columns,
    width,
    height: FILMSTRIP_HEIGHT,
  })
}

/** Where the picture cuts to another shot, from a small copy of each frame. */
async function cuts(source, durationMs) {
  const run = await execute(
    "ffmpeg",
    [
      ...["-i", source, "-an", "-sn", "-dn"],
      ...["-vf", `scale=160:-2,select='gt(scene,${CUT_SCENE_SCORE})',showinfo`],
      ...["-f", "null", "-"],
    ],
    { timeoutMs: 60_000 + durationMs / 2, level: "info" }
  )
  if (run.failed) return { status: "failed", reason: "The cuts could not be found.", detail: run.failed }

  const atMs = []
  for (const match of run.stderr.matchAll(/Parsed_showinfo.*?pts_time:\s*([\d.]+)/g)) {
    const at = Math.round(Number(match[1]) * 1000)
    if (!(at > 0) || at - (atMs.at(-1) ?? 0) < MIN_SHOT_MS) continue
    atMs.push(at)
    if (atMs.length === MAX_CUTS) break
  }
  return { status: "ready", atMs }
}

/** The sound's peaks, each from 0 to 100 of full scale, 50 a second, as JSON. */
async function waveform(durationMs) {
  const file = path.join(out, "waveform.json")
  const bucket = PEAK_SAMPLE_RATE / PEAKS_PER_SECOND
  const peaks = []
  let peak = 0
  let filled = 0
  let carry = Buffer.alloc(0)

  const run = await execute(
    "ffmpeg",
    [
      ...["-i", original, "-vn", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE)],
      ...["-f", "s16le", "-c:a", "pcm_s16le", "-"],
    ],
    {
      timeoutMs: 60_000 + durationMs / 5,
      // Read as it comes: half an hour of samples is 29 MB.
      onStdout(chunk) {
        const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
        const whole = bytes.length - (bytes.length % 2)
        for (let at = 0; at < whole; at += 2) {
          peak = Math.max(peak, Math.abs(bytes.readInt16LE(at)))
          filled += 1
          if (filled === bucket) {
            peaks.push(Math.min(100, Math.round((peak / 32768) * 100)))
            peak = 0
            filled = 0
          }
        }
        carry = bytes.subarray(whole)
      },
    }
  )
  if (run.failed) return { status: "failed", reason: "Its sound could not be read.", detail: run.failed }
  if (filled > 0) peaks.push(Math.min(100, Math.round((peak / 32768) * 100)))

  fs.writeFileSync(file, JSON.stringify({ peaksPerSecond: PEAKS_PER_SECOND, peaks }))
  return {
    status: "ready",
    path: file,
    bytes: fs.statSync(file).size,
    mediaType: "application/json",
  }
}

/** The sound, small, as transcription models take it: mono, 16 kHz, MP3. */
async function speech(durationMs) {
  const file = path.join(out, "audio.mp3")
  const args = ["-i", original, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"]
  return made(
    await execute("ffmpeg", [...args, file], { timeoutMs: 60_000 + durationMs / 5 }),
    { path: file, mediaType: "audio/mpeg" }
  )
}

/** A part ready with the file a run wrote, or failed with why. */
function made(run, ready) {
  const bytes = !run.failed && fs.existsSync(ready.path) ? fs.statSync(ready.path).size : 0
  if (bytes > 0) return { status: "ready", ...ready, bytes }
  return { status: "failed", reason: "FFmpeg could not make it.", detail: run.failed ?? "it wrote nothing" }
}

function seconds(ms) {
  return (ms / 1000).toFixed(3)
}

/** Whether a tool runs at all. */
async function available(tool) {
  const run = await execute(tool, ["-version"], { timeoutMs: 10_000 })
  return !run.missing && !run.failed
}

/**
 * Runs FFmpeg or ffprobe, killed past `timeoutMs` or the script's budget, whichever is first:
 * `failed` says why it did not succeed, with the end of what it wrote to stderr.
 */
function execute(tool, args, options) {
  const timeoutMs = Math.min(options.timeoutMs, deadline - Date.now())
  if (timeoutMs <= 0) return Promise.resolve({ failed: "it ran out of time", stderr: "" })

  const level = tool === "ffmpeg" ? ["-hide_banner", "-nostdin", "-y", "-v", options.level ?? "error"] : []
  return new Promise((resolve) => {
    const child = spawn(tool, [...level, ...args], { stdio: ["ignore", "pipe", "pipe"] })
    const stdout = []
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    child.stdout.on("data", (chunk) => {
      if (options.onStdout) options.onStdout(chunk)
      else if (options.stdout) stdout.push(chunk)
    })
    // The cuts read every line FFmpeg logs; anything else keeps only the end of it.
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
      if (options.level !== "info" && stderr.length > STDERR_BYTES * 2) {
        stderr = stderr.slice(-STDERR_BYTES)
      }
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ missing: error.code === "ENOENT", failed: error.message, stderr })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const failed = timedOut
        ? `it ran out of time after ${Math.round(timeoutMs / 1000)} seconds`
        : code === 0
          ? undefined
          : `exit ${code}: ${stderr.trim().slice(-500)}`
      resolve({ failed, stdout: Buffer.concat(stdout), stderr })
    })
  })
}
