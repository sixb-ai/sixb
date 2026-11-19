import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CreateSandboxOptions,
  type FileRef,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Sandbox,
  type SandboxFactory,
  SixbHost,
} from "@sixb/core"
import { MEDIA_JOB } from "@sixb/core/internal/artifacts/publish"
import type { TranscriptionModel } from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { deriveArtifactMedia, failArtifactMedia } from "../src/media"
import { RenderWorker } from "../src/worker"
import { startDownloadApi } from "./download-api"

const projectId = "media"

/**
 * The project's sandboxes, real bash and curl on this host, whose FFmpeg is the test: asked to
 * derive, it writes what `made` says for each part it is asked for, as the media script reports
 * it, and keeps the parts each run was asked for and the original it found.
 */
class DerivingSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  readonly asked: { readonly parts: string[]; readonly original: string }[] = []
  /** Resolves each time a sandbox is destroyed, which ends a job's work in its sandbox. */
  private onDestroy: (() => void) | undefined

  destroyedOnce(): Promise<void> {
    return new Promise((resolve) => {
      this.onDestroy = resolve
    })
  }

  constructor(
    private readonly made: (part: string) => Record<string, unknown> | "file" = () => "file",
    private readonly report?: Record<string, unknown>
  ) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.created.push(options)
    const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create()
    const run = sandbox.runCommand.bind(sandbox)
    const destroy = sandbox.destroy.bind(sandbox)

    return Object.assign(sandbox, {
      destroy: async () => {
        await destroy()
        this.onDestroy?.()
      },
      runCommand: async (...[command, args, runOptions]: Parameters<Sandbox["runCommand"]>) => {
        const script = args?.at(-1) ?? ""
        if (!script.includes("media.cjs")) return run(command, args, runOptions)

        // exec node 'media.cjs' '<original>' '<out>' '<budget>' '<max duration>' '<parts>'
        const [, original = "", out = "", , , wanted = ""] =
          script
            .slice(script.indexOf("exec node"))
            .match(/'[^']*'/g)
            ?.map((arg) => arg.slice(1, -1)) ?? []
        const parts = wanted.split(",").filter(Boolean)
        this.asked.push({ parts, original: readFileSync(original, "utf8") })

        mkdirSync(out, { recursive: true })
        const file = (name: string, body: string, mediaType: string, more = {}) => {
          writeFileSync(join(out, name), body)
          return { status: "ready", path: join(out, name), bytes: body.length, mediaType, ...more }
        }
        const files: Record<string, () => Record<string, unknown>> = {
          proxy: () => file("proxy.mp4", "proxy", "video/mp4"),
          poster: () => file("poster.jpg", "poster", "image/jpeg", { atMs: 1520 }),
          filmstrip: () =>
            file("filmstrip.jpg", "filmstrip", "image/jpeg", {
              intervalMs: 1000,
              count: 16,
              columns: 10,
              width: 160,
              height: 90,
            }),
          waveform: () =>
            file("waveform.json", '{"peaksPerSecond":50,"peaks":[]}', "application/json"),
          cuts: () => ({ status: "ready", atMs: [1200, 8200] }),
          audio: () => file("audio.mp3", "speech", "audio/mpeg"),
        }
        const report = this.report ?? {
          parts: {
            probe: {
              status: "ready",
              durationMs: 15_200,
              container: "mov,mp4,m4a,3gp,3g2,mj2",
              video: { codec: "h264", width: 1280, height: 720, rotation: 0, fps: 30 },
              audio: { codec: "aac", sampleRate: 22_050, channels: 1 },
            },
            ...Object.fromEntries(
              parts.map((part) => {
                const made = this.made(part)
                return [part, made === "file" ? files[part]?.() : made]
              })
            ),
          },
        }
        return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "", durationMs: 0 }
      },
    })
  }
}

const apis: { close(): void }[] = []
const workers: RenderWorker[] = []
afterEach(async () => {
  for (const api of apis.splice(0)) api.close()
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
})

function transcriber(
  transcribe: TranscriptionModel["transcribe"] = async () => ({
    output: {
      text: "Welcome to Sixb.",
      language: "en",
      words: [{ text: "Welcome", startMs: 300, endMs: 700 }],
    },
  })
): TranscriptionModel {
  return {
    providerId: "test",
    modelId: "transcriber",
    definition: {
      kind: "transcription",
      providerId: "test",
      modelId: "transcriber",
      maxInputBytes: 1024,
    },
    transcribe,
  }
}

async function setup(
  options: {
    readonly sandboxes?: DerivingSandboxes
    readonly transcription?: TranscriptionModel | null
  } = {}
) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const sandboxes = options.sandboxes ?? new DerivingSandboxes()
  const transcription = options.transcription === undefined ? transcriber() : options.transcription
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    queues: new InMemoryQueues(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    sandboxes,
    ...(transcription ? { models: { audio: { transcription: [transcription] } } } : {}),
  })
  const api = startDownloadApi(host)
  apis.push(api)

  const clip = await blobStorage.put({
    body: new TextEncoder().encode("the original clip"),
    fileName: "Launch clip.mp4",
    mediaType: "video/mp4",
  })
  const job = (file: FileRef = clip, attempt = 1) => ({
    id: `art_media_${file.digest.slice(7)}`,
    projectId,
    createdAt: new Date().toISOString(),
    availableAt: new Date().toISOString(),
    attempt,
    type: "artifact.media.requested" as const,
    payload: { file },
  })
  const derive = (file?: FileRef, attempt?: number) =>
    deriveArtifactMedia({ host, job: job(file, attempt), signal: new AbortController().signal })
  const kept = async (file: FileRef = clip) => {
    const [media] =
      (await storage.artifacts?.listMedia({ projectId, digests: [file.digest] })) ?? []
    return media
  }
  const read = async (file: FileRef) => new Response(await blobStorage.open(file.blobId)).text()
  return { host, storage, blobStorage, sandboxes, api, clip, job, derive, kept, read }
}

describe("what the render worker derives of a media", () => {
  // Reproduce by writing the original with `writeFiles` in derive(): the API serves nothing, and
  // the worker holds the whole film to write it.
  test("is derived from the original, fetched by URL, and kept part by part", async () => {
    const { sandboxes, api, clip, derive, kept, read } = await setup()

    await derive()

    expect(sandboxes.asked).toEqual([
      {
        parts: ["proxy", "poster", "filmstrip", "waveform", "cuts", "audio"],
        original: "the original clip",
      },
    ])
    expect(api.served.map(({ blobId }) => blobId)).toEqual([clip.blobId])
    expect(sandboxes.created[0]?.network).toMatchObject({
      mode: "restricted",
      allow: expect.arrayContaining([{ name: "127.0.0.1", origin: api.origin }]),
    })

    const media = await kept()
    expect(media).toMatchObject({
      digest: clip.digest,
      attempts: 1,
      parts: {
        probe: { status: "ready", durationMs: 15_200, video: { width: 1280, height: 720 } },
        proxy: {
          status: "ready",
          file: { fileName: "Launch clip.proxy.mp4", mediaType: "video/mp4" },
        },
        poster: { status: "ready", atMs: 1520, file: { fileName: "Launch clip.poster.jpg" } },
        filmstrip: { status: "ready", intervalMs: 1000, count: 16, columns: 10, width: 160 },
        waveform: { status: "ready", file: { fileName: "Launch clip.waveform.json" } },
        cuts: { status: "ready", atMs: [1200, 8200] },
        transcript: { status: "ready", language: "en" },
      },
    })
    const { parts } = media ?? {}
    if (parts?.proxy.status !== "ready" || parts.transcript.status !== "ready") {
      throw new Error("Expected the proxy and the transcript.")
    }
    expect(await read(parts.proxy.file)).toBe("proxy")
    expect(JSON.parse(await read(parts.transcript.file))).toEqual({
      text: "Welcome to Sixb.",
      language: "en",
      words: [{ text: "Welcome", startMs: 300, endMs: 700 }],
    })

    // Derived, nothing is derived again.
    await derive()
    expect(sandboxes.created).toHaveLength(1)
  })

  // Reproduce by throwing from derive() when a part fails: the poster that was made is lost with
  // the proxy that was not, and the job makes both again.
  test("keeps each part as it stands: a poster ready while the proxy failed", async () => {
    const sandboxes = new DerivingSandboxes((part) =>
      part === "proxy"
        ? { status: "failed", reason: "FFmpeg could not make it.", detail: "exit 1: codec" }
        : part === "cuts"
          ? { status: "unavailable", reason: "It has no picture." }
          : "file"
    )
    const { derive, kept } = await setup({ sandboxes })

    await derive()

    expect((await kept())?.parts).toMatchObject({
      proxy: { status: "failed", reason: "FFmpeg could not make it." },
      poster: { status: "ready" },
      cuts: { status: "unavailable", reason: "It has no picture." },
    })
    // What FFmpeg said goes to the logs, not to the reader.
    expect(JSON.stringify((await kept())?.parts.proxy)).not.toContain("codec")
  })

  // Reproduce by asking the script for every part in derive(): a crash after the first keep
  // derives the proxy again only to transcribe.
  test("derives only what is still pending, as an attempt cut short left it", async () => {
    const { storage, sandboxes, clip, derive, kept } = await setup()
    await derive()
    const media = await kept()
    if (!media) throw new Error("Expected what was derived.")
    await storage.artifacts?.putMedia({
      ...media,
      parts: { ...media.parts, transcript: { status: "pending" } },
    })

    await derive(clip, 2)

    expect(sandboxes.asked.at(-1)?.parts).toEqual(["audio"])
    expect(await kept()).toMatchObject({
      attempts: 2,
      parts: { proxy: media.parts.proxy, transcript: { status: "ready" } },
    })
  })

  // Reproduce by keeping `...derived.parts` with the transcript in deriveArtifactMedia: it keeps the
  // proxy failed as the job first made it, and the job asked for behind it finds nothing to do.
  test("leaves pending what a retry asked for while it ran, for the job behind it", async () => {
    let retry = async () => {}
    const sandboxes = new DerivingSandboxes((part) =>
      part === "proxy" ? { status: "failed", reason: "FFmpeg could not make it." } : "file"
    )
    const { storage, derive, kept } = await setup({
      sandboxes,
      transcription: transcriber(async () => {
        await retry()
        return { output: { text: "Welcome to Sixb." } }
      }),
    })
    // While the model transcribes, the proxy that failed is asked for again.
    retry = async () => {
      const media = await kept()
      if (!media) throw new Error("Expected what was derived first.")
      await storage.artifacts?.putMedia({
        ...media,
        parts: { ...media.parts, proxy: { status: "pending" } },
      })
    }

    await derive()

    expect((await kept())?.parts).toMatchObject({
      proxy: { status: "pending" },
      transcript: { status: "ready" },
    })
  })

  // Reproduce by asking for the sound without a model in derive(): the sandbox extracts and the
  // worker reads back a sound nothing will transcribe.
  test("has no transcript in a project without a transcription model", async () => {
    const { sandboxes, derive, kept } = await setup({ transcription: null })

    await derive()

    expect(sandboxes.asked[0]?.parts).not.toContain("audio")
    expect((await kept())?.parts.transcript).toEqual({
      status: "unavailable",
      reason: "This project has no transcription model.",
    })
  })

  test("keeps why the model did not transcribe, and what else was derived", async () => {
    const { derive, kept } = await setup({
      transcription: transcriber(async () => {
        throw new Error("upstream unavailable")
      }),
    })

    await derive()

    expect((await kept())?.parts).toMatchObject({
      proxy: { status: "ready" },
      transcript: {
        status: "failed",
        reason: "The transcription model could not transcribe it.",
      },
    })
  })

  test("is unavailable, not failed, in sandboxes without FFmpeg", async () => {
    const sandboxes = new DerivingSandboxes(undefined, { skipped: "no_ffmpeg" })
    const { derive, kept } = await setup({ sandboxes })

    await derive()

    expect((await kept())?.parts.proxy).toEqual({
      status: "unavailable",
      reason: "This project's sandboxes have no FFmpeg to derive it with (the agent image has it).",
    })
  })

  // Reproduce by returning `{ kind: "fail" }` at once in onExecutionError: a sandbox that failed
  // to start once leaves the clip without a proxy for good.
  test("tries again when the script stops, and keeps what is still pending as failed after", async () => {
    const sandboxes = new DerivingSandboxes(undefined, { failed: "killed" })
    const { host, storage, clip, job, derive, kept } = await setup({ sandboxes })

    const stopped = await derive().catch((error: unknown) => error)
    expect(String(stopped)).toContain("killed")
    expect(await kept()).toBeUndefined()

    // Its last attempt given up, what was derived before stays, and the rest failed.
    const poster = { status: "ready", file: clip, atMs: 0 } as const
    await storage.artifacts?.putMedia({
      projectId,
      digest: clip.digest,
      parts: {
        probe: { status: "pending" },
        proxy: { status: "pending" },
        poster,
        filmstrip: { status: "pending" },
        waveform: { status: "pending" },
        cuts: { status: "pending" },
        transcript: { status: "pending" },
      },
      attempts: 1,
      updatedAt: new Date(),
    })
    await failArtifactMedia({ host, job: job(clip, MEDIA_JOB.attempts) })
    expect((await kept())?.parts).toMatchObject({
      poster,
      proxy: { status: "failed", reason: "It could not be derived." },
      transcript: { status: "failed", reason: "It could not be derived." },
    })
  })

  test("is derived by a running worker, from the renders lane", async () => {
    const { host, sandboxes, clip, kept } = await setup()
    const worker = new RenderWorker(host)
    workers.push(worker)
    await worker.start()

    const derived = sandboxes.destroyedOnce()
    await host.queues.renders.enqueue({
      projectId,
      jobs: [
        {
          id: `art_media_${clip.digest.slice(7)}`,
          type: "artifact.media.requested",
          payload: { file: clip },
        },
      ],
    })

    await derived
    // Then transcribed, outside the sandbox.
    for (
      let turn = 0;
      turn < 500 && (await kept())?.parts.transcript.status !== "ready";
      turn += 1
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect((await kept())?.parts.transcript.status).toBe("ready")
  })
})
