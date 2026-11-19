import { posix } from "node:path"
import type { FileRef, Sandbox } from "@sixb/core"
import {
  MAX_MEDIA_DURATION_MS,
  MEDIA_JOB,
  MEDIA_PARTS,
  type MediaJobBudget,
  mapMediaParts,
  mediaJobBudget,
  unmadeMediaParts,
} from "@sixb/core/internal/artifacts/publish"
import { findMediaTranscriber, type MediaTranscriber } from "@sixb/core/internal/runtime"
import { parseArtifactMediaProbe } from "@sixb/core/internal/storage"
import type { ArtifactMediaRequestedQueueJob } from "@sixb/core/queues"
import type {
  ArtifactMediaFilmstrip,
  ArtifactMediaPart,
  ArtifactMediaPartName,
  ArtifactMediaParts,
  ArtifactMediaProbe,
} from "@sixb/core/storage"
import type { RenderHost } from "./host"
import mediaScript from "./media.cjs" with { type: "text" }
import {
  downloadIntoSandbox,
  inRenderSandbox,
  type RenderDownloadHost,
  readSandboxFiles,
  renderApiOrigin,
  runScript,
  scriptFiles,
  storeSandboxFile,
} from "./sandbox"

// What Sixb derives from a video or a sound, once for every file that holds its bytes. The worker
// opens a blank sandbox of the project that reaches the API, which fetches the original by a
// download URL; the image's FFmpeg derives each part there; the files it wrote stream back into
// blob storage, and the sandbox is destroyed. Its sound is then transcribed by the project's
// model, outside the sandbox. Each part is kept as it stands as soon as it does, so a poster
// shows while the transcript is on its way.

/** What deriving a media reads, opens and keeps: a render's, and the API's download URLs. */
export type MediaHost = RenderHost & RenderDownloadHost

/** Where the original is fetched to in the sandbox, and where the script writes what it derives. */
const ORIGINAL = "media/original"
const OUT = "media/derived"
const SCRIPT = "media.cjs"
/** Of the time left once the original is probed: the rest reads what it derived back. */
const DERIVE_SHARE = 0.8
/** How long ffprobe may read the original, before the probe says how long the rest takes. */
const PROBE_MS = 90_000

/** The script's own parts: the transcript needs its sound, which the host transcribes. */
const SCRIPT_PARTS: Partial<Record<ArtifactMediaPartName, string>> = {
  proxy: "proxy",
  poster: "poster",
  filmstrip: "filmstrip",
  waveform: "waveform",
  cuts: "cuts",
  transcript: "audio",
}

/**
 * Derives what is still pending of a media, and keeps each part as it stands. Repeating it derives
 * nothing more: a part already kept stays. A project without sandboxes derives nothing.
 */
export async function deriveArtifactMedia(input: {
  readonly host: MediaHost
  readonly job: ArtifactMediaRequestedQueueJob
  readonly signal: AbortSignal
}): Promise<void> {
  const { host, job } = input
  const artifacts = host.storage.artifacts
  if (!artifacts || !host.sandboxes) return

  const { file } = job.payload
  const [kept] = await artifacts.listMedia({ projectId: host.id, digests: [file.digest] })
  const before = kept?.parts ?? unmadeMediaParts(() => ({ status: "pending" }))
  const wanted = MEDIA_PARTS.filter((name) => before[name].status === "pending")
  if (wanted.length === 0) return

  // Asked for again once its job was lost after its last attempt: what is pending failed.
  const attempt = (kept?.attempts ?? 0) + 1
  if (attempt > MEDIA_JOB.attempts) return failArtifactMedia({ host, job })

  const transcriber = findMediaTranscriber(host)
  const transcribes = wanted.includes("transcript") && transcriber?.model != null
  /**
   * Keeps the parts this attempt made over what is kept by then, not over what it read first: a
   * retry asked meanwhile made other parts pending again, for the job waiting behind this one, and
   * counts its attempts from 0 again.
   */
  const keep = async (made: Partial<ArtifactMediaParts>, attempts?: number) => {
    const [now] = await artifacts.listMedia({ projectId: host.id, digests: [file.digest] })
    await artifacts.putMedia({
      projectId: host.id,
      digest: file.digest,
      parts: { ...(now?.parts ?? before), ...made },
      attempts: attempts ?? now?.attempts ?? attempt,
      updatedAt: new Date(),
    })
  }

  // The attempt is counted before it starts, so one that is cut short still counts.
  await keep({}, attempt)
  const startedAt = Date.now()

  const derived = await inRenderSandbox(
    { sandboxes: host.sandboxes },
    `derived ${mediaName(file)}`,
    { timeoutMs: MEDIA_JOB.maxTimeoutMs, signal: input.signal, reach: [renderApiOrigin(host)] },
    (sandbox, left, signal) =>
      derive({
        host,
        sandbox,
        signal,
        file,
        jobId: job.id,
        probe: before.probe.status === "ready" ? before.probe : undefined,
        keepProbe: (probe) => keep({ probe }),
        // What is left of the attempt once the media is probed, its transcription aside.
        left: (budget) =>
          Math.min(left(), startedAt + budget.timeoutMs - budget.transcribeMs - Date.now()),
        // Without a transcription model, the sound is not extracted for one.
        wanted: transcribes ? wanted : wanted.filter((name) => name !== "transcript"),
        maxAudioBytes: transcribes ? (transcriber?.model?.maxInputBytes ?? 0) : 0,
      })
  )

  await keep({
    ...derived.parts,
    ...(wanted.includes("transcript") && !transcribes
      ? {
          transcript: {
            status: "unavailable",
            reason: "This project has no transcription model.",
            lacks: "transcription_model",
          },
        }
      : {}),
  })

  if (derived.audio && transcriber) {
    await keep({
      transcript: await transcribe({
        host,
        transcriber,
        file,
        job,
        attempt,
        audio: derived.audio,
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(derived.budget.transcribeMs)]),
      }),
    })
  }
}

/** How many attempts were made at a media since it was last asked for, as what is kept says. */
export async function mediaAttempts(input: {
  readonly host: Pick<RenderHost, "id" | "storage">
  readonly job: ArtifactMediaRequestedQueueJob
}): Promise<number> {
  const { digest } = input.job.payload.file
  const [kept] =
    (await input.host.storage.artifacts?.listMedia({
      projectId: input.host.id,
      digests: [digest],
    })) ?? []
  return kept?.attempts ?? input.job.attempt
}

/**
 * Keeps each part still pending as failed, once the worker gives up on the media: whoever waits
 * for it hears so, and what was derived before stays.
 */
export async function failArtifactMedia(input: {
  readonly host: Pick<RenderHost, "id" | "storage">
  readonly job: ArtifactMediaRequestedQueueJob
}): Promise<void> {
  const artifacts = input.host.storage.artifacts
  if (!artifacts) return

  const { digest } = input.job.payload.file
  const [kept] = await artifacts.listMedia({ projectId: input.host.id, digests: [digest] })
  const failed = { status: "failed", reason: "It could not be derived." } as const
  const parts = kept?.parts ?? unmadeMediaParts(() => failed)
  await artifacts.putMedia({
    projectId: input.host.id,
    digest,
    parts: mapMediaParts(parts, (part) => (part.status === "pending" ? failed : part)),
    attempts: kept?.attempts ?? input.job.attempt,
    updatedAt: new Date(),
  })
}

/**
 * Fetches the original into `sandbox`, a blank one created for it, probes it unless an attempt
 * did, derives the `wanted` parts there in the time the probe gives it, and stores the files it
 * wrote. The sound for the transcript comes back as bytes, at most `maxAudioBytes`, for the host
 * to transcribe.
 */
async function derive(input: {
  readonly host: MediaHost
  readonly sandbox: Sandbox
  readonly signal: AbortSignal
  readonly file: FileRef
  readonly jobId: string
  /** What an earlier attempt read the media holds. */
  readonly probe: ArtifactMediaProbe | undefined
  readonly keepProbe: (probe: ArtifactMediaParts["probe"]) => Promise<void>
  /** What is left of the attempt: before the probe, of the longest any media has. */
  readonly left: (budget: MediaJobBudget) => number
  readonly wanted: readonly ArtifactMediaPartName[]
  readonly maxAudioBytes: number
}): Promise<{
  readonly parts: Partial<ArtifactMediaParts>
  readonly audio?: Uint8Array
  readonly budget: MediaJobBudget
}> {
  const { host, sandbox, signal, file } = input
  const original = posix.resolve(sandbox.workingDirectory, ORIGINAL)
  const out = posix.resolve(sandbox.workingDirectory, OUT)
  const unprobed = mediaJobBudget(undefined)

  await downloadIntoSandbox(host, sandbox, [{ path: original, file }], {
    timeoutMs: input.left(unprobed),
    signal,
    executionId: input.jobId,
  })
  await sandbox.writeFiles(scriptFiles(sandbox, SCRIPT, mediaScript))

  // What the media holds says how long the rest may take.
  let probe = input.probe
  if (!probe) {
    const probed = await runMedia(input, [original, out, PROBE_MS, MAX_MEDIA_DURATION_MS, 0, ""])
    if ("lacking" in probed)
      return { parts: pickParts(probed.lacking, input.wanted), budget: unprobed }

    const part = probePart(probed.reported.probe)
    await input.keepProbe(part)
    if (part.status !== "ready") {
      const unread = unmadeMediaParts(() => ({ status: "failed", reason: part.reason }))
      return { parts: pickParts({ ...unread, probe: part }, input.wanted), budget: unprobed }
    }
    probe = part
  }

  // Part of what is left, so the script says what it made before its command is killed.
  const budget = mediaJobBudget(probe)
  const timeoutMs = Math.max(0, input.left(budget))
  const scriptParts = input.wanted.flatMap((name) => SCRIPT_PARTS[name] ?? [])
  const run = await runMedia({ ...input, timeoutMs }, [
    original,
    out,
    Math.floor(Math.min(budget.deriveMs, timeoutMs * DERIVE_SHARE)),
    MAX_MEDIA_DURATION_MS,
    budget.proxyMs,
    scriptParts.join(","),
  ])
  if ("lacking" in run) return { parts: pickParts(run.lacking, input.wanted), budget }
  const { reported } = run

  const wants = (name: ArtifactMediaPartName) => input.wanted.includes(name)
  /** A file the script wrote, stored as its part with what `fields` reads of the report. */
  const stored = async <T extends object>(
    part: Exclude<ArtifactMediaPartName, "probe" | "cuts" | "transcript">,
    fields: (file: FileRef, made: ReadyFile) => T | null
  ): Promise<ArtifactMediaPart<T>> => {
    const made = reported[part]
    if (!isReady(made)) return notMade(made, part, file)

    const kept = await storeSandboxFile(
      host.blobStorage,
      sandbox,
      {
        path: made.path,
        bytes: made.bytes,
        fileName: `${baseName(file)}.${part}${posix.extname(made.path)}`,
        mediaType: made.mediaType,
      },
      { signal }
    )
    const ready = fields(kept, made)
    return ready ? { status: "ready", ...ready } : notMade(undefined, part, file)
  }

  const parts: Partial<ArtifactMediaParts> = {
    ...(wants("probe") ? { probe: probePart(reported.probe) } : {}),
    ...(wants("proxy") ? { proxy: await stored("proxy", (kept) => ({ file: kept })) } : {}),
    ...(wants("poster")
      ? {
          poster: await stored("poster", (kept, made) =>
            isCount(made.atMs) ? { file: kept, atMs: made.atMs } : null
          ),
        }
      : {}),
    ...(wants("filmstrip") ? { filmstrip: await stored("filmstrip", filmstripFields) } : {}),
    ...(wants("waveform")
      ? { waveform: await stored("waveform", (kept) => ({ file: kept })) }
      : {}),
    ...(wants("cuts") ? { cuts: cutsPart(reported.cuts, file) } : {}),
  }
  if (!wants("transcript")) return { parts, budget }

  // The sound comes back whole, for the model; one past what the model takes is not transcribed.
  const sound = reported.audio
  if (!isReady(sound)) {
    return { parts: { ...parts, transcript: notMade(sound, "transcript", file) }, budget }
  }
  if (sound.bytes > input.maxAudioBytes) {
    const reason = "It is too long for this project's transcription model."
    return { parts: { ...parts, transcript: { status: "unavailable", reason } }, budget }
  }
  const [audio] = await readSandboxFiles(sandbox, [{ path: sound.path, bytes: sound.bytes }], {
    maxBytes: input.maxAudioBytes,
    signal,
  })
  if (!(audio instanceof Uint8Array)) {
    throw new Error(`[SixbRenderWorker] The sound of ${mediaName(file)} could not be read back.`)
  }
  return { parts: { ...parts, transcript: { status: "pending" } }, audio, budget }
}

/**
 * Runs media.cjs with `args`, within what is left, and reads its report: each part it made or why
 * not, or every part unavailable in a sandbox without the tools, until the project's image has
 * them. A script that reports nothing throws, and the job tries again.
 */
async function runMedia(
  input: {
    readonly sandbox: Sandbox
    readonly signal: AbortSignal
    readonly file: FileRef
    readonly timeoutMs?: number
  },
  args: readonly (string | number)[]
): Promise<
  { readonly reported: Record<string, unknown> } | { readonly lacking: ArtifactMediaParts }
> {
  const { sandbox, signal } = input
  const timeoutMs = input.timeoutMs ?? PROBE_MS + 30_000
  const script = posix.resolve(sandbox.workingDirectory, SCRIPT)
  const { report, stderr } = await runScript(sandbox, script, args, { timeoutMs, signal })

  if (report?.skipped) {
    const tool = report.skipped === "no_node" ? "Node.js" : "FFmpeg"
    const reason = `This project's sandboxes have no ${tool} to derive it with (the agent image has it).`
    const lacking = { status: "unavailable", reason, lacks: "sandbox_tools" } as const
    return { lacking: unmadeMediaParts(() => lacking) }
  }

  const reported = report?.parts
  if (!isRecord(reported)) {
    throw new Error(
      `[SixbRenderWorker] Deriving ${mediaName(input.file)} stopped: ${String(report?.failed ?? (stderr || "the script reported nothing")).slice(0, 500)}`
    )
  }
  return { reported }
}

/** A file the script wrote: where it is, how large, its type, and what else it says of it. */
interface ReadyFile {
  readonly status: "ready"
  readonly path: string
  readonly bytes: number
  readonly mediaType: string
  readonly [field: string]: unknown
}

/** The filmstrip's geometry, as the script laid it out. */
function filmstripFields(file: FileRef, made: ReadyFile): ArtifactMediaFilmstrip | null {
  const { intervalMs, count, columns, width, height } = made
  if (!isPositive(intervalMs) || !isPositive(count) || !isPositive(columns)) return null
  if (!isPositive(width) || !isPositive(height)) return null
  return { file, intervalMs, count, columns, width, height }
}

/** What the script said of a part it did not make, as a reader hears it; its detail is logged. */
function notMade(
  made: unknown,
  part: ArtifactMediaPartName,
  file: FileRef
): ArtifactMediaPart<never> {
  const said = isRecord(made) ? made : {}
  const status = said.status === "unavailable" ? "unavailable" : "failed"
  const reason = typeof said.reason === "string" ? said.reason : "It was not made."
  if (status === "failed") {
    console.warn(
      `[SixbRenderWorker] The ${part} of ${mediaName(file)} failed: ${String(said.detail ?? reason).slice(0, 500)}`
    )
  }
  return { status, reason }
}

/** The `names` of `parts`, and none else. */
function pickParts(
  parts: ArtifactMediaParts,
  names: readonly ArtifactMediaPartName[]
): Partial<ArtifactMediaParts> {
  const picked: { -readonly [K in ArtifactMediaPartName]?: ArtifactMediaParts[K] } = {}
  const pick = <K extends ArtifactMediaPartName>(name: K) => {
    picked[name] = parts[name]
  }
  for (const name of names) pick(name)
  return picked
}

/** The script's probe, with only what a probe holds. */
function probePart(
  made: unknown
):
  | ({ readonly status: "ready" } & ArtifactMediaProbe)
  | { readonly status: "failed"; readonly reason: string } {
  const probe = isRecord(made) && made.status === "ready" ? parseArtifactMediaProbe(made) : null
  if (probe) return { status: "ready", ...probe }

  const reason = isRecord(made) && typeof made.reason === "string" ? made.reason : undefined
  return { status: "failed", reason: reason ?? "It could not be read." }
}

/** The script's cuts, each a moment in milliseconds. */
function cutsPart(
  made: unknown,
  file: FileRef
): ArtifactMediaPart<{ readonly atMs: readonly number[] }> {
  if (isRecord(made) && made.status === "ready" && Array.isArray(made.atMs)) {
    return { status: "ready", atMs: made.atMs.filter(isCount) }
  }
  return notMade(made, "cuts", file)
}

/** Transcribes the sound, and keeps the transcript as JSON; why not, when the model refused. */
async function transcribe(input: {
  readonly host: MediaHost
  readonly transcriber: MediaTranscriber
  readonly file: FileRef
  readonly job: ArtifactMediaRequestedQueueJob
  /** The attempt at the media, which the model's calls are recorded under. */
  readonly attempt: number
  readonly audio: Uint8Array
  readonly signal: AbortSignal
}): Promise<ArtifactMediaParts["transcript"]> {
  const { file } = input
  try {
    const output = await input.transcriber.transcribe({
      digest: file.digest,
      jobId: input.job.id,
      attempt: input.attempt,
      audio: { data: input.audio, mediaType: "audio/mpeg" },
      signal: input.signal,
    })
    const body = new TextEncoder().encode(JSON.stringify(output))
    const stored = await input.host.blobStorage.put({
      body,
      expectedSizeBytes: body.byteLength,
      fileName: `${baseName(file)}.transcript.json`,
      mediaType: "application/json",
    })
    return {
      status: "ready",
      file: stored,
      ...(output.language ? { language: output.language } : {}),
    }
  } catch (error) {
    input.signal.throwIfAborted()
    console.warn(`[SixbRenderWorker] Could not transcribe ${mediaName(file)}:`, error)
    return { status: "failed", reason: "The transcription model could not transcribe it." }
  }
}

function isReady(made: unknown): made is ReadyFile {
  return (
    isRecord(made) &&
    made.status === "ready" &&
    typeof made.path === "string" &&
    typeof made.bytes === "number" &&
    made.bytes > 0 &&
    typeof made.mediaType === "string"
  )
}

/** A whole number from 0, such as milliseconds. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The original's name without its extension, which what is derived of it is named after. */
function baseName(file: FileRef): string {
  const name = file.fileName ? posix.basename(file.fileName) : "media"
  return name.replace(/\.[^.]+$/, "") || "media"
}

/** How logs name a media: its file name and its digest. */
function mediaName(file: FileRef): string {
  return `'${file.fileName ?? "media"}' (${file.digest.slice(0, 19)}…)`
}
