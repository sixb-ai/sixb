import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ArtifactFile,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { videoStillKey } from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { RenderWorker } from "../src"
import { startDownloadApi } from "./download-api"

// A video exported with the real HyperFrames and FFmpeg, as the agent image ships them, by the
// render worker, scene by scene: on this host's path, which a local sandbox takes. Without both it
// skips. Run it in the image, the repository mounted:
//
//   docker run --rm -v "$PWD":/w -w /w sixb-agent:1.4.0 \
//     bash -lc 'bun test ./packages/render-worker/tests/video-export.e2e.ts'
//
// Three scenes over music that crosses both cuts: the outro fades in over the demo, so its segment
// renders as a range of its project, the others from frame 0.
const tools = ["hyperframes", "ffmpeg", "ffprobe", "node"].every((tool) => Bun.which(tool))

/** Runs a tool, with `input` on its stdin, killed past two minutes, and returns its stdout. */
async function run(tool: string, args: readonly string[], input?: Uint8Array): Promise<Buffer> {
  const child = Bun.spawn([tool, ...args], {
    stdin: input ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`${tool} exited ${code}: ${stderr}`)
    return Buffer.from(stdout)
  } finally {
    clearTimeout(timer)
  }
}

const scene = (id: string, body: string) =>
  `<template>\n  <div data-composition-id="${id}" data-width="640" data-height="360">\n${body}\n  </div>\n</template>\n`

const title = (id: string, text: string, color: string) =>
  scene(
    id,
    `    <style>.${id} { position: absolute; inset: 0; background: ${color}; color: #fff; font: 700 64px sans-serif; display: grid; place-items: center; }</style>
    <div class="${id}" id="${id}-title">${text}</div>
    <script>
      const tl = gsap.timeline({ paused: true })
      tl.from("#${id}-title", { opacity: 0, y: 40, duration: 0.6 }, 0.1)
      window.__timelines = window.__timelines || {}
      window.__timelines["${id}"] = tl
    </script>`
  )

const INDEX = `<!doctype html>
<html><head>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>html, body { margin: 0; background: #000; } .scene { position: absolute; inset: 0; }</style>
</head><body>
  <div id="main" data-composition-id="main" data-width="640" data-height="360" data-fps="30" data-duration="5.5">
    <div id="intro" class="scene" data-composition-id="intro" data-composition-src="scenes/intro.html" data-start="0" data-duration="2"></div>
    <div id="demo" class="scene" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="intro" data-duration="2"></div>
    <div id="outro" class="scene" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="demo - 0.5" data-duration="2"></div>
    <audio id="music" src="media/music.m4a" data-start="0" data-duration="5.5"></audio>
  </div>
</body></html>
`

let dir = ""
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sixb-video-export-e2e-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!tools)("a video exported scene by scene", () => {
  test(
    "plays every frame with music unbroken at the cuts, and renders again only the scene edited",
    async () => {
      const clip = join(dir, "clip.mp4")
      const music = join(dir, "music.m4a")
      await run("ffmpeg", [
        ...["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3"],
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clip],
      ])
      // A steady tone: any gap or click at a cut shows in its level there.
      await run("ffmpeg", [
        ...["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6"],
        ...["-c:a", "aac", "-b:a", "192k", "-y", music],
      ])

      const blobStorage = new InMemoryBlobStorage()
      const storage = new InMemoryStorage()
      const queues = new InMemoryQueues()
      const host = new SixbHost({
        id: "video",
        ontology: [],
        storage,
        blobStorage,
        sandboxes: new LocalSandboxFactory({ isolation: "none" }),
        queues,
        broker: new InMemoryBroker(),
        lakeStorage: new InMemoryLakeStorage(),
      })
      const sixb = createTestSixb(host, {
        authorization: {
          principal: { type: "user", id: "alice" },
          groupIds: [],
          roleIds: [],
          grants: emptyGrantIndex(),
        },
      })

      // Every segment the worker is asked for, by its scene, or the sound.
      const segments: string[] = []
      const enqueue = queues.renders.enqueue.bind(queues.renders)
      queues.renders.enqueue = async (params) => {
        for (const job of params.jobs) {
          if (job.type === "artifact.video.segment.requested") {
            const { segment } = job.payload
            segments.push(segment.kind === "sound" ? "sound" : segment.scene)
          }
        }
        return enqueue(params)
      }

      const put = async (path: string, body: string | Uint8Array): Promise<ArtifactFile> => ({
        path,
        file: await blobStorage.put({
          body: typeof body === "string" ? new TextEncoder().encode(body) : body,
          fileName: path,
        }),
      })
      const files = async (greeting: string) => [
        await put("index.html", INDEX),
        await put("scenes/intro.html", title("intro", greeting, "#2d3a8c")),
        await put(
          "scenes/demo.html",
          scene(
            "demo",
            '    <video src="media/clip.mp4" data-start="0" data-duration="2" muted playsinline></video>'
          )
        ),
        await put("scenes/outro.html", title("outro", "Thanks", "#8c2d5a")),
        await put("media/clip.mp4", await readFile(clip)),
        await put("media/music.m4a", await readFile(music)),
      ]

      const api = startDownloadApi(host)
      const worker = new RenderWorker(host, { concurrency: 4 })
      await worker.start()
      try {
        const exported = async (artifactId: string) => {
          const deadline = Date.now() + 240_000
          for (;;) {
            const asked = await sixb.artifacts.video(artifactId)
            if (asked?.status === "ready") return asked
            if (asked?.status === "failed") throw new Error(`The export failed: ${asked.reason}`)
            if (Date.now() > deadline) throw new Error("The export took more than 4 minutes.")
            await Bun.sleep(1000)
          }
        }

        const { version } = await sixb.artifacts.create({
          kind: "video",
          title: "Launch",
          files: await files("Hello"),
        })
        const first = await exported(version.artifactId)
        expect(first.durationMs).toBe(5500)
        expect([...segments].sort()).toEqual(["demo", "intro", "outro", "sound"])

        // It plays: H.264 and AAC, every one of its 165 frames.
        const mp4 = join(dir, "export.mp4")
        await writeFile(
          mp4,
          new Uint8Array(
            await new Response(await blobStorage.open(first.file.blobId)).arrayBuffer()
          )
        )
        const probe = JSON.parse(
          (
            await run("ffprobe", [
              ...["-v", "error", "-count_frames", "-print_format", "json"],
              ...["-show_entries", "stream=codec_name,codec_type,nb_read_frames", mp4],
            ])
          ).toString("utf8")
        ) as { streams: { codec_name: string; codec_type: string; nb_read_frames?: string }[] }
        expect(probe.streams.map((stream) => stream.codec_name).sort()).toEqual(["aac", "h264"])
        expect(probe.streams.find((stream) => stream.codec_type === "video")?.nb_read_frames).toBe(
          "165"
        )
        await run("ffmpeg", ["-v", "error", "-i", mp4, "-f", "null", "-"])

        // The tone holds its level across both cuts, at 2 and 3.5 seconds: no gap, no click.
        // Reproduce a dip by joining each segment's own sound instead of the whole video's (map
        // `0:a` in video.cjs's segment and assemble): the tone falls by 2.5 dB at a cut.
        const pcm = await run("ffmpeg", [
          ...["-v", "error", "-i", mp4, "-map", "a:0", "-ac", "1", "-ar", "48000"],
          ...["-f", "f32le", "-"],
        ])
        const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
        const level = (atSeconds: number) => {
          const start = Math.round((atSeconds - 0.01) * 48_000)
          let sum = 0
          for (let index = start; index < start + 960; index += 1) sum += (samples[index] ?? 0) ** 2
          return Math.sqrt(sum / 960)
        }
        const steady = level(1)
        for (const cut of [2, 3.5]) {
          for (const at of [cut - 0.02, cut, cut + 0.02]) {
            expect(Math.abs(20 * Math.log10(level(at) / steady))).toBeLessThan(1)
          }
        }

        // The intro edited: its segment renders again, and the sound, which any scene's HTML may
        // shape; the demo's and the outro's are reused. Reproduce a full render by keying each
        // segment with every scene's render key in videoExportPlan: all three render again.
        segments.length = 0
        await sixb.artifacts.update(version.artifactId, {
          kind: "video",
          title: "Launch",
          files: await files("Welcome"),
        })
        const second = await exported(version.artifactId)
        expect(second.file.digest).not.toBe(first.file.digest)
        expect([...segments].sort()).toEqual(["intro", "sound"])

        // Each scene of the latest version gets its still, asked for once the video rests: a JPEG
        // of its middle, at the video's own width.
        const latest = await sixb.artifacts.getVersion(version.artifactId, "latest")
        if (latest?.outline.kind !== "video") throw new Error("Expected a video.")
        const keys = latest.outline.scenes.map(videoStillKey)
        const deadline = Date.now() + 120_000
        let stills = await storage.artifacts.listVideoRenders({ projectId: "video", keys })
        while (stills.length < keys.length && Date.now() < deadline) {
          await Bun.sleep(1000)
          stills = await storage.artifacts.listVideoRenders({ projectId: "video", keys })
        }
        expect(stills).toHaveLength(3)
        for (const still of stills) {
          if ("failure" in still) throw new Error(`A still failed: ${still.failure}`)
          const jpeg = Buffer.from(
            await new Response(await blobStorage.open(still.file.blobId)).arrayBuffer()
          )
          expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8")
          const size = (
            await run(
              "ffprobe",
              [...["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "-"]],
              jpeg
            )
          )
            .toString("utf8")
            .trim()
          expect(size).toBe("640,360")
        }
      } finally {
        await worker.stop()
        api.close()
      }
    },
    { timeout: 600_000 }
  )
})
