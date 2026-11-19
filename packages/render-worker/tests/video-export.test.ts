import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import {
  type ArtifactFile,
  type CreateSandboxOptions,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Sandbox,
  type SandboxFactory,
  SixbHost,
} from "@sixb/core"
import {
  VIDEO_EXPORT_JOB,
  videoExportJobId,
  videoExportPlan,
} from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import type {
  ArtifactVideoExportRequestedQueueJob,
  ArtifactVideoSegmentRequestedQueueJob,
  RenderQueueJob,
} from "@sixb/core/queues"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { assembleVideoExport } from "../src/video-export"
import { failVideoSegment, renderVideoSegment } from "../src/video-segment"
import { startDownloadApi } from "./download-api"

const projectId = "videos"

/**
 * The project's sandboxes, real bash and curl on this host, whose HyperFrames and FFmpeg are the
 * test: asked to run `video.cjs`, each mode writes a file named after what it made, and reports
 * it, unless `report` says otherwise. Each run's mode, arguments and project are kept.
 */
class VideoSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  readonly ran: { readonly mode: string; readonly args: string[]; readonly index?: string }[] = []

  constructor(private readonly report?: (mode: string) => Record<string, unknown> | undefined) {}

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.created.push(options)
    const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create()
    const run = sandbox.runCommand.bind(sandbox)

    return Object.assign(sandbox, {
      runCommand: async (...[command, args, runOptions]: Parameters<Sandbox["runCommand"]>) => {
        const script = args?.at(-1) ?? ""
        if (!script.includes("video.cjs")) return run(command, args, runOptions)

        // exec node 'video.cjs' '<mode>' '<arg>'...
        const [, mode = "", ...rest] =
          script
            .slice(script.indexOf("exec node"))
            .match(/'[^']*'/g)
            ?.map((arg) => arg.slice(1, -1)) ?? []
        const project = mode === "assemble" ? undefined : rest[0]
        this.ran.push({
          mode,
          args: rest,
          ...(project ? { index: readFileSync(`${project}/index.html`, "utf8") } : {}),
        })

        // A segment holds the scenes its project hosts; the MP4, its segments, in order.
        const out = mode === "assemble" ? (rest[0] ?? "") : (rest[1] ?? "")
        const hosted = [
          ...(this.ran.at(-1)?.index ?? "").matchAll(/data-composition-src="scenes\/(\w+)/g),
        ]
        const body =
          mode === "assemble"
            ? rest
                .slice(4)
                .map((path) => readFileSync(path, "utf8"))
                .join("|")
            : mode === "segment"
              ? hosted.map((match) => match[1]).join("+")
              : mode
        writeFileSync(out, body)
        const report = this.report?.(mode) ?? {
          status: "ready",
          path: out,
          bytes: body.length,
          mediaType: "video/mp4",
        }
        return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "", durationMs: 0 }
      },
    })
  }
}

const apis: { close(): void }[] = []
afterEach(() => {
  for (const api of apis.splice(0)) api.close()
  setSystemTime()
})

const scene = (id: string, body = `<h1>${id}</h1>`) =>
  `<template><div data-composition-id="${id}" data-width="1280" data-height="720">${body}</div></template>`
const host = (id: string, start: string, duration: string) =>
  `<div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${start}" data-duration="${duration}"></div>`

/** A title, a demo over a clip, and an outro that fades in over the demo's last half second. */
const LAUNCH: Readonly<Record<string, string>> = {
  "index.html": `<html><body><div data-composition-id="main" data-width="1280" data-height="720" data-duration="6">${[
    host("intro", "0", "2"),
    host("demo", "intro", "2.5"),
    host("outro", "demo - 0.5", "2"),
    '<audio src="media/music.m4a" data-start="0" data-duration="6"></audio>',
  ].join("")}</div></body></html>`,
  "scenes/intro.html": scene("intro"),
  "scenes/demo.html": scene("demo", '<video src="media/clip.mp4" muted></video>'),
  "scenes/outro.html": scene("outro"),
  "media/clip.mp4": "clip",
  "media/music.m4a": "music",
}

async function setup(sandboxes = new VideoSandboxes()) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const queues = new InMemoryQueues()
  const sixbHost = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    queues,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    sandboxes,
  })
  apis.push(startDownloadApi(sixbHost))
  const sixb = createTestSixb(sixbHost, {
    authorization: {
      principal: { type: "user", id: "alice" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })

  const files: ArtifactFile[] = []
  for (const [path, body] of Object.entries(LAUNCH)) {
    const mediaType = path.endsWith(".mp4")
      ? "video/mp4"
      : path.endsWith(".m4a")
        ? "audio/mp4"
        : "text/html"
    files.push({
      path,
      file: await blobStorage.put({ body: new TextEncoder().encode(body), mediaType }),
    })
  }
  const { version } = await sixb.artifacts.create({ kind: "video", title: "Launch: Q4", files })

  /** The jobs the render worker would claim now, each done once claimed. */
  const claimable = async (): Promise<RenderQueueJob[]> => {
    const claims = await queues.renders.claim({ projectId, workerId: "test", limit: 20 })
    for (const { job, leaseId } of claims) {
      await queues.renders.complete({ projectId, jobId: job.id, leaseId })
    }
    return claims.map(({ job }) => job)
  }
  // What publishing asked for, the media derived and the stills, is not under test here.
  await claimable()

  const exportJob = async () => {
    await sixb.artifacts.video(version.artifactId)
    const [job] = await claimable()
    if (job?.type !== "artifact.video.export.requested") throw new Error("Expected an export.")
    return job
  }
  const signal = new AbortController().signal
  const assemble = (job: ArtifactVideoExportRequestedQueueJob) =>
    assembleVideoExport({ host: sixbHost, job, signal })
  const render = (job: ArtifactVideoSegmentRequestedQueueJob) =>
    renderVideoSegment({ host: sixbHost, job, signal })
  const text = async (file: { readonly blobId: string }) =>
    new Response(await blobStorage.open(file.blobId)).text()
  const artifacts = () => {
    if (!storage.artifacts) throw new Error("Expected artifact storage.")
    return storage.artifacts
  }
  return { sixb, version, sandboxes, claimable, exportJob, assemble, render, text, artifacts }
}

const segmentsOf = (jobs: readonly RenderQueueJob[]) =>
  jobs.filter(
    (job): job is ArtifactVideoSegmentRequestedQueueJob =>
      job.type === "artifact.video.segment.requested"
  )

describe("a video's export in the render worker", () => {
  // Reproduce by putting `index.html` as written in sceneProject, not videoSegmentIndex's: each
  // segment renders every scene.
  test("asks for each segment, each with its scenes alone, and looks again a few seconds later", async () => {
    const { exportJob, assemble, claimable, sandboxes, text } = await setup()
    const job = await exportJob()

    await assemble(job)
    expect(sandboxes.created).toHaveLength(0)

    const asked = await claimable()
    const segments = segmentsOf(asked)
    expect(segments.map(({ payload }) => payload.segment)).toEqual([
      { kind: "scene", scene: "intro", startFrame: 0, endFrame: 60 },
      { kind: "scene", scene: "demo", startFrame: 60, endFrame: 120 },
      { kind: "scene", scene: "outro", startFrame: 120, endFrame: 180 },
      { kind: "sound" },
    ])

    // The intro alone, from frame 0, without the demo's clip; the outro over the demo it fades
    // in over, a range of their project; the sound from every file.
    const [intro, demo, outro, sound] = segments.map(({ payload }) => payload)
    const paths = (files: readonly ArtifactFile[] | undefined) => files?.map(({ path }) => path)
    expect(paths(intro?.files)).toEqual(["index.html", "scenes/intro.html", "media/music.m4a"])
    expect(intro?.frames).toEqual({ from: 0, to: 60 })
    const introIndex = await text(intro?.files[0]?.file ?? { blobId: "" })
    expect(introIndex).toContain('id="intro"')
    expect(introIndex).not.toContain('id="demo"')
    expect(introIndex).toContain('data-duration="2"')
    expect(demo?.frames).toEqual({ from: 0, to: 60 })
    expect(paths(outro?.files)).toContain("media/clip.mp4")
    expect(outro?.frames).toEqual({ from: 60, to: 120 })
    expect(paths(sound?.files)).toEqual(Object.keys(LAUNCH))

    // It looks again a few seconds later, asking for nothing then.
    expect(asked.some((each) => each.type === "artifact.video.export.requested")).toBe(false)
    setSystemTime(new Date(Date.now() + VIDEO_EXPORT_JOB.recheckMs))
    const [again] = await claimable()
    expect(again?.id).toBe(job.id)
    expect(again?.payload).toMatchObject({ waiting: true })
  })

  // Reproduce by leaving out the `waiting` check in assembleVideoExport: each look asks for every
  // missing segment again, reading the version's HTML each time.
  test("looks again without asking for the segments again", async () => {
    const { exportJob, assemble, claimable } = await setup()
    const job = await exportJob()

    await assemble({ ...job, payload: { ...job.payload, waiting: true } })
    setSystemTime(new Date(Date.now() + VIDEO_EXPORT_JOB.recheckMs))
    const asked = await claimable()
    expect(asked.map((each) => each.type)).toEqual(["artifact.video.export.requested"])
  })

  // Reproduce by leaving out the kept check in renderVideoSegment: the segment renders twice.
  test("renders a segment once, and joins the segments in order with the sound", async () => {
    const { sixb, version, exportJob, assemble, render, claimable, sandboxes, text, artifacts } =
      await setup()
    const job = await exportJob()
    await assemble(job)
    const segments = segmentsOf(await claimable())

    for (const segment of segments) await render(segment)
    await render(segments[0] as ArtifactVideoSegmentRequestedQueueJob)
    expect(sandboxes.created).toHaveLength(4)
    expect(sandboxes.ran.map(({ mode }) => mode)).toEqual([
      "segment",
      "segment",
      "segment",
      "sound",
    ])

    await assemble(job)
    const joined = sandboxes.ran.at(-1)
    // Its frames, the sound, then each scene's segment, in the order they play.
    expect(joined?.mode).toBe("assemble")
    expect(joined?.args[2]).toBe("180")
    expect(joined?.args[3]).toEndWith("/sound.m4a")

    const plan = videoExportPlan(job.payload)
    const [mp4] = await artifacts().listVideoRenders({ projectId, keys: [plan.key] })
    if (!mp4 || "failure" in mp4) throw new Error("Expected the MP4.")
    expect(mp4.file).toMatchObject({ fileName: "Launch Q4.mp4", mediaType: "video/mp4" })
    // The demo's project hosts the outro, which fades in over its end.
    expect(await text(mp4.file)).toBe("intro|demo+outro|demo+outro")

    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "ready",
      file: mp4.file,
      durationMs: 6000,
      sizeBytes: mp4.file.sizeBytes,
    })
    expect(await claimable()).toEqual([])
  })

  // Reproduce by throwing for a skipped report in renderVideoSegment: the job tries again with a
  // sandbox that will never have HyperFrames.
  test("keeps why a sandbox cannot render at once, which fails the export", async () => {
    const sandboxes = new VideoSandboxes((mode) =>
      mode === "segment" ? { skipped: "engine", engine: "hyperframes@0.9.70" } : undefined
    )
    const { sixb, version, exportJob, assemble, render, claimable } = await setup(sandboxes)
    const job = await exportJob()
    await assemble(job)
    const [intro] = segmentsOf(await claimable())
    await render(intro as ArtifactVideoSegmentRequestedQueueJob)

    await assemble(job)
    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "failed",
      reason:
        "This project's sandboxes run hyperframes@0.9.70, and videos render with hyperframes@0.9.68, as the agent image installs it.",
    })
  })

  // Reproduce by asking for the segments without `replace` on a retry: the failed segment's job,
  // settled, answers the ask, and the export waits forever.
  test("names the scene that could not render, and renders it again when asked", async () => {
    const { sixb, version, exportJob, assemble, claimable, artifacts } = await setup()
    const job = await exportJob()
    await assemble(job)
    const [, demo] = segmentsOf(await claimable())
    if (!demo) throw new Error("Expected the demo's segment.")
    await failVideoSegment({
      host: { id: projectId, storage: { artifacts: artifacts() } },
      job: demo,
    })

    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "failed",
      reason: "Scene 'demo' could not be rendered. Try again in a moment.",
    })

    await sixb.artifacts.video(version.artifactId, { retry: true })
    const [retried] = await claimable()
    expect(retried?.id).toBe(videoExportJobId(job.payload.key))
    await assemble(retried as ArtifactVideoExportRequestedQueueJob)
    const asked = await claimable()
    expect(segmentsOf(asked).map(({ id }) => id)).toContain(demo.id)
  })
})
