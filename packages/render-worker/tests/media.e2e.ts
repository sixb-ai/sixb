import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
import type { TranscriptionModelRequest } from "@sixb/core/models"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { deriveArtifactMedia } from "../src/media"
import { startDownloadApi } from "./download-api"

// A clip derived with a real FFmpeg, as the agent image ships it: FFmpeg and ffprobe on the
// sandbox's path, which a local sandbox takes from this host's. Without both it skips.
//
//   bun test ./packages/render-worker/tests/media.e2e.ts
//
// The clip opens on 1.2 seconds of black, cuts to a test pattern, then at 8.2 seconds to colour
// bars, over a tone: its poster is not black, and its cuts are found where they are.
const ffmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null

/** Runs FFmpeg or ffprobe, killed past a minute, and returns its stdout. */
async function run(tool: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([tool, "-v", "error", ...args], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`${tool} exited ${code}: ${stderr}`)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}

let dir = ""
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sixb-media-e2e-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!ffmpeg)("a clip derived with FFmpeg", () => {
  test(
    "plays as a 720p proxy that scrubs, shows a poster that is not black, and is transcribed",
    async () => {
      // Reproduce the poster by taking the frame at one second in poster(): it is black. The
      // keyframes, by leaving -force_key_frames out of proxy(): one every 250 frames.
      const clip = join(dir, "clip.mp4")
      await run("ffmpeg", [
        ...["-f", "lavfi", "-i", "color=black:size=1920x1080:rate=30:duration=1.2"],
        ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=7"],
        ...["-f", "lavfi", "-i", "smptehdbars=size=1920x1080:rate=30:duration=7"],
        ...["-f", "lavfi", "-i", "sine=frequency=330:duration=15.2"],
        ...["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]"],
        ...["-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"],
        ...["-y", clip],
      ])

      const storage = new InMemoryStorage()
      const blobStorage = new InMemoryBlobStorage()
      const heard: TranscriptionModelRequest[] = []
      const host = new SixbHost({
        id: "media",
        ontology: [],
        storage,
        blobStorage,
        sandboxes: new LocalSandboxFactory({ isolation: "none" }),
        queues: new InMemoryQueues(),
        broker: new InMemoryBroker(),
        lakeStorage: new InMemoryLakeStorage(),
        models: {
          audio: {
            transcription: [
              {
                providerId: "test",
                modelId: "transcriber",
                definition: {
                  kind: "transcription",
                  providerId: "test",
                  modelId: "transcriber",
                  maxInputBytes: 4 * 1024 * 1024,
                },
                async transcribe(request) {
                  heard.push(request)
                  return { output: { text: "A tone.", language: "en" } }
                },
              },
            ],
          },
        },
      })
      const api = startDownloadApi(host)
      try {
        const file = await blobStorage.put({
          body: await readFile(clip),
          fileName: "clip.mp4",
          mediaType: "video/mp4",
        })
        await deriveArtifactMedia({
          host,
          job: {
            id: `art_media_${file.digest.slice(7)}`,
            projectId: "media",
            createdAt: new Date().toISOString(),
            availableAt: new Date().toISOString(),
            attempt: 1,
            type: "artifact.media.requested",
            payload: { file },
          },
          signal: AbortSignal.timeout(110_000),
        })

        const [media] = await storage.artifacts.listMedia({
          projectId: "media",
          digests: [file.digest],
        })
        const parts = media?.parts
        if (!parts) throw new Error("Expected what was derived.")
        expect(parts.probe).toMatchObject({
          status: "ready",
          durationMs: 15_200,
          faststart: false,
          video: { codec: "h264", width: 1920, height: 1080, rotation: 0, fps: 30 },
          audio: { codec: "aac" },
        })
        expect(parts.cuts).toEqual({ status: "ready", atMs: [1200, 8200] })
        expect(parts.filmstrip).toMatchObject({
          status: "ready",
          intervalMs: 1000,
          count: 16,
          columns: 10,
          width: 160,
          height: 90,
        })
        expect(parts.transcript).toMatchObject({ status: "ready", language: "en" })

        // The poster is past the black opening.
        if (parts.poster.status !== "ready") throw new Error("Expected a poster.")
        expect(parts.poster.atMs).toBeGreaterThan(1200)

        // The proxy: H.264 720p, a keyframe every half second, its index first, AAC.
        if (parts.proxy.status !== "ready") throw new Error("Expected a proxy.")
        const proxy = join(dir, "proxy.mp4")
        await writeFile(proxy, await blobBytes(blobStorage, parts.proxy.file.blobId))
        expect(
          (
            await run("ffprobe", [
              "-show_entries",
              "stream=codec_name,width,height",
              "-of",
              "csv=p=0",
              proxy,
            ])
          )
            .trim()
            .split("\n")
        ).toEqual(["h264,1280,720", "aac"])
        const keyframes = await run("ffprobe", [
          ...["-select_streams", "v", "-skip_frame", "nokey"],
          ...["-show_entries", "frame=pts_time", "-of", "csv=p=0", proxy],
        ])
        // One time to a line, which older ffprobes follow with a line of side data.
        const times = keyframes.split("\n").map(Number.parseFloat).filter(Number.isFinite)
        expect(times.slice(0, 4)).toEqual([0, 0.5, 1, 1.5])
        const head = await blobBytes(blobStorage, parts.proxy.file.blobId)
        expect(Buffer.from(head).toString("latin1").indexOf("moov")).toBeLessThan(
          Buffer.from(head).toString("latin1").indexOf("mdat")
        )

        // 50 peaks a second, of a tone that is never silent: lavfi's sine plays at an eighth of
        // full scale.
        if (parts.waveform.status !== "ready") throw new Error("Expected a waveform.")
        const waveform = JSON.parse(
          new TextDecoder().decode(await blobBytes(blobStorage, parts.waveform.file.blobId))
        )
        expect(waveform.peaksPerSecond).toBe(50)
        // 15.2 seconds, give or take the AAC encoder's priming, which FFmpeg 5 decodes as sound.
        expect(Math.abs(waveform.peaks.length - 760)).toBeLessThanOrEqual(2)
        expect(Math.min(...waveform.peaks.slice(5, -5))).toBe(12)

        // The model heard the sound as MP3, mono, 16 kHz.
        expect(heard.map(({ mediaType }) => mediaType)).toEqual(["audio/mpeg"])
        const sound = join(dir, "sound.mp3")
        await writeFile(sound, heard[0]?.audio ?? new Uint8Array())
        expect(
          (
            await run("ffprobe", [
              ...["-show_entries", "stream=codec_name,channels,sample_rate"],
              ...["-of", "csv=p=0", sound],
            ])
          ).trim()
        ).toBe("mp3,16000,1")
      } finally {
        api.close()
      }
    },
    { timeout: 120_000 }
  )
})

async function blobBytes(blobStorage: InMemoryBlobStorage, blobId: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await blobStorage.open(blobId)).arrayBuffer())
}
