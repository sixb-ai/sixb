import { afterEach, describe, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
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
  missingVideoStills,
  VIDEO_ENGINE,
  VIDEO_EXPORT_JOB,
  VIDEO_SEGMENT_JOB,
  VIDEO_STILLS_JOB,
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
import { assembleVideoExport, failVideoExport } from "../src/video-export"
import { failVideoSegment, renderVideoSegment } from "../src/video-segment"
import { RenderWorker } from "../src/worker"
import { startDownloadApi } from "./download-api"

const projectId = "videos"

/**
 * The project's sandboxes, real bash and curl on this host, whose HyperFrames and FFmpeg are the
 * test: asked to run `video.cjs`, each mode writes a file named after what it made, and reports
 * it, unless `report` says otherwise. Each run's mode, arguments and project are kept: its
 * `index.html`, and every file laid out there, by its path.
 */
class VideoSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  readonly ran: {
    readonly mode: string
    readonly args: string[]
    readonly index?: string
    readonly project?: Readonly<Record<string, string>>
  }[] = []

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
        const laid = project
          ? readdirSync(project, { recursive: true, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => `${entry.parentPath}/${entry.name}`.slice(project.length + 1))
          : []
        this.ran.push({
          mode,
          args: rest,
          ...(project
            ? {
                index: readFileSync(`${project}/index.html`, "utf8"),
                project: Object.fromEntries(
                  laid.map((path) => [path, readFileSync(`${project}/${path}`, "utf8")])
                ),
              }
            : {}),
        })

        // A segment holds the scenes its project hosts; the MP4, its segments, in order.
        const out = mode === "assemble" ? (rest[0] ?? "") : (rest[1] ?? "")
        const hosted = [
          ...(this.ran.at(-1)?.index ?? "").matchAll(/data-composition-src="scenes\/(\w+)/g),
        ]
        const body =
          mode === "assemble"
            ? rest
                .slice(5)
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

/** Sandboxes that never open, so each render fails as it starts. */
class ClosedSandboxes extends VideoSandboxes {
  override async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.created.push(options)
    throw new Error("No sandbox opens here.")
  }
}

const apis: { close(): void }[] = []
const workers: RenderWorker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
  for (const api of apis.splice(0)) api.close()
  jest.useRealTimers()
  mock.restore()
  setSystemTime()
})

const scene = (id: string, body = `<h1>${id}</h1>`) =>
  `<template><div data-composition-id="${id}" data-width="1280" data-height="720">${body}</div></template>`
const host = (id: string, start: string, duration: string, label?: string) =>
  `<div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${start}" data-duration="${duration}"${label ? ` data-label="${label}"` : ""}></div>`

/**
 * A title, a demo over a muted clip, named "The product", and an outro that fades in over the
 * demo's last half second, where someone says thanks.
 */
const LAUNCH: Readonly<Record<string, string>> = {
  "index.html": `<html><body><div data-composition-id="main" data-width="1280" data-height="720" data-duration="6">${[
    host("intro", "0", "2"),
    host("demo", "intro", "2.5", "The product"),
    host("outro", "demo - 0.5", "2"),
    '<audio src="media/music.m4a" data-start="0" data-duration="6"></audio>',
  ].join("")}</div></body></html>`,
  "scenes/intro.html": scene("intro"),
  "scenes/demo.html": scene("demo", '<video src="media/clip.mp4" muted></video>'),
  "scenes/outro.html": scene("outro", '<video src="media/thanks.mp4"></video>'),
  "media/clip.mp4": "clip",
  "media/thanks.mp4": "thanks",
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
  return {
    host: sixbHost,
    sixb,
    version,
    queues,
    sandboxes,
    claimable,
    exportJob,
    assemble,
    render,
    text,
    artifacts,
  }
}

const segmentsOf = (jobs: readonly RenderQueueJob[]) =>
  jobs.filter(
    (job): job is ArtifactVideoSegmentRequestedQueueJob =>
      job.type === "artifact.video.segment.requested"
  )

const exportsOf = (jobs: readonly RenderQueueJob[]) =>
  jobs.filter(
    (job): job is ArtifactVideoExportRequestedQueueJob =>
      job.type === "artifact.video.export.requested"
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
      { kind: "scene", scene: "demo", label: "The product", startFrame: 60, endFrame: 120 },
      { kind: "scene", scene: "outro", startFrame: 120, endFrame: 180 },
      { kind: "sound" },
    ])

    // The intro alone, from frame 0, without the demo's clip; the outro over the demo it fades
    // in over, a range of their project; the sound from every file but the clip, which is muted.
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
    expect(paths(sound?.files)).toEqual(
      Object.keys(LAUNCH).filter((path) => path !== "media/clip.mp4")
    )

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

    // The last segment kept, the export looks again at once, and joins them.
    const [look] = await claimable()
    expect(look?.id).toBe(job.id)
    await assemble(look as ArtifactVideoExportRequestedQueueJob)
    const joined = sandboxes.ran.at(-1)
    // Its frames and their rate, the sound, then each scene's segment, in the order they play.
    expect(joined?.mode).toBe("assemble")
    expect(joined?.args[2]).toBe("180")
    expect(joined?.args[3]).toBe("30")
    expect(joined?.args[4]).toEndWith("/sound.m4a")

    const plan = videoExportPlan(job.payload)
    const [mp4] = await artifacts().listVideoRenders({ projectId, keys: [plan.key] })
    if (!mp4 || "failure" in mp4) throw new Error("Expected the MP4.")
    // Kept for every version made the same, it is named after the title of the one read.
    expect(mp4.file).toMatchObject({ fileName: "video.mp4", mediaType: "video/mp4" })
    // The outro fades in as the demo's segment ends: only its own project hosts both.
    expect(await text(mp4.file)).toBe("intro|demo|demo+outro")

    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "ready",
      file: { ...mp4.file, fileName: "Launch Q4.mp4" },
      durationMs: 6000,
      sizeBytes: mp4.file.sizeBytes,
    })
    expect(await claimable()).toEqual([])
  })

  // Reproduce by asking for the sound with the version's files as they are, as it once did: the
  // sandbox fetches the muted clip, which can be gigabytes of footage the sound never plays.
  test("mixes the sound from the footage it hears, without fetching the muted clip", async () => {
    const { exportJob, assemble, render, claimable, sandboxes } = await setup()
    await assemble(await exportJob())
    const sound = segmentsOf(await claimable()).find(
      ({ payload }) => payload.segment.kind === "sound"
    )
    if (!sound) throw new Error("Expected the sound's segment.")

    await render(sound)
    const [mixed] = sandboxes.ran
    expect(mixed?.mode).toBe("sound")
    expect(Object.keys(mixed?.project ?? {}).sort()).toEqual([
      "index.html",
      "media/music.m4a",
      "media/thanks.mp4",
      "scenes/demo.html",
      "scenes/intro.html",
      "scenes/outro.html",
    ])
    // HyperFrames looks for no file of the muted clip, which plays none there.
    expect(mixed?.project?.["scenes/demo.html"]).toBe(scene("demo", "<video  muted></video>"))
    expect(mixed?.project?.["scenes/outro.html"]).toBe(LAUNCH["scenes/outro.html"])
  })

  // Reproduce by leaving nudgeVideoExport out of renderVideoSegment's `keep`: the export looks
  // again only VIDEO_EXPORT_JOB.recheckMs later.
  test("asks the export that waits for a segment to look again as soon as it is kept", async () => {
    const { exportJob, assemble, render, claimable } = await setup()
    const job = await exportJob()
    await assemble(job)
    const [intro] = segmentsOf(await claimable())

    await render(intro as ArtifactVideoSegmentRequestedQueueJob)
    const [look] = await claimable()
    expect(look?.id).toBe(job.id)
    expect(look?.payload).toMatchObject({ key: job.payload.key, waiting: true })
    expect(look?.payload).not.toHaveProperty("retry")
  })

  // Reproduce by returning for a key that differs from the payload's, as it once did: the job
  // completes, and asking again for the export finds it settled and asks nothing.
  test("tries again while the version that asked keys exports otherwise, then says so", async () => {
    const { exportJob, assemble, artifacts } = await setup()
    const job = await exportJob()
    const skewed = { ...job, payload: { ...job.payload, key: "f".repeat(64) } }

    const failed = await assemble(skewed).catch((error: unknown) => error)
    expect(String(failed)).toContain("asked for by another version of Sixb")

    await failVideoExport({
      host: { id: projectId, storage: { artifacts: artifacts() } },
      job: skewed,
    })
    const [kept] = await artifacts().listVideoRenders({ projectId, keys: [skewed.payload.key] })
    expect(kept).toMatchObject({
      failure: "It was asked for while Sixb was being updated. Try again.",
    })
  })

  // Reproduce by throwing for a skipped report in renderVideoSegment: the job tries again with a
  // sandbox that will never have HyperFrames. Reproduce `lacks` by leaving it out of cannotRender:
  // the app then offers a retry that cannot work.
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
      reason: `This project's sandboxes run hyperframes@0.9.70, and videos render with ${VIDEO_ENGINE}, as the agent image installs it.`,
      lacks: "sandbox_tools",
    })
  })

  // Reproduce by asking for the segments without `replace` on a retry: the failed segment's job,
  // settled, answers the ask, and the export waits forever.
  test("names the scene that could not render, and renders it again when asked", async () => {
    const { sixb, version, queues, exportJob, assemble, claimable, artifacts } = await setup()
    const job = await exportJob()
    await assemble(job)
    const [, demo] = segmentsOf(await claimable())
    if (!demo) throw new Error("Expected the demo's segment.")
    await failVideoSegment({
      host: { id: projectId, storage: { artifacts: artifacts() }, queues },
      job: demo,
    })

    // Reproduce by naming the scene by its id alone: "Scene 'demo'".
    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "failed",
      reason: "Scene 'The product' could not be rendered. Try again in a moment.",
    })
    // The export that waited for it heard at once.
    expect((await claimable()).map(({ id }) => id)).toEqual([job.id])

    await sixb.artifacts.video(version.artifactId, { retry: true })
    const [retried] = await claimable()
    expect(retried?.payload).toMatchObject({ key: job.payload.key, retry: true })
    await assemble(retried as ArtifactVideoExportRequestedQueueJob)
    const asked = await claimable()
    expect(segmentsOf(asked).map(({ id }) => id)).toContain(demo.id)
  })

  // Reproduce by asking for a retry in the export's own job, videoExportJobId, as it once was: the
  // intro, kept before the retry runs, takes its place with the export as first asked for, which
  // asks for nothing, and the demo is never rendered again. Reproduce the last look's `askedAt` by
  // returning at once for a segment found kept in renderVideoSegment.
  test("asks again for a scene that failed, though another finishes before the retry runs", async () => {
    const { sixb, version, queues, exportJob, assemble, render, claimable, artifacts } =
      await setup()
    const job = await exportJob()
    await assemble(job)
    const [intro, demo, outro, sound] = segmentsOf(await claimable())
    if (!intro || !demo || !outro || !sound) throw new Error("Expected the segments.")

    // The demo fails while the others render, and the export hears so.
    await failVideoSegment({
      host: { id: projectId, storage: { artifacts: artifacts() }, queues },
      job: demo,
    })
    for (const look of exportsOf(await claimable())) await assemble(look)

    // Retried a minute later, behind the intro, which is kept meanwhile and nudges the export.
    setSystemTime(new Date(Date.now() + 60_000))
    await sixb.artifacts.video(version.artifactId, { retry: true })
    await render(intro)

    // Their stills, asked for when the video was published, are not under test here.
    const exports = exportsOf(await claimable())
    const retry = exports.find(({ payload }) => payload.retry)
    for (const each of exports) await assemble(each)
    const asked = segmentsOf(await claimable())
    expect(asked.map(({ id }) => id)).toEqual([demo.id, outro.id, sound.id])

    // The outro, still rendering as first asked when the retry asked for it again, nudges the
    // export as first asked; its job the retry asked for finds it kept, and nudges as retried.
    await render(outro)
    await render(asked[1] as ArtifactVideoSegmentRequestedQueueJob)
    const [look] = await claimable()
    expect(look?.payload).toMatchObject({ waiting: true, askedAt: retry?.payload.askedAt })
    expect(retry?.payload.askedAt).not.toBe(job.payload.askedAt)
  })
})

/**
 * A render worker on the project's lane, whose deliveries are counted by type. `until` runs its
 * timers a second at a time, its backoffs included, until `done`, for at most `ms` of them.
 */
async function runWorker(host: ConstructorParameters<typeof RenderWorker>[0]) {
  const deliveries = new Map<string, number>()
  const claim = host.queues.renders.claim.bind(host.queues.renders)
  host.queues.renders.claim = async (input) => {
    const claimed = await claim(input)
    for (const { job } of claimed) deliveries.set(job.type, (deliveries.get(job.type) ?? 0) + 1)
    return claimed
  }

  const worker = new RenderWorker(host)
  workers.push(worker)
  await worker.start()

  const until = async (done: () => Promise<boolean>, ms: number) => {
    for (let elapsed = 0; elapsed <= ms; elapsed += 1_000) {
      for (let turn = 0; turn < 20; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (await done()) return
      jest.advanceTimersByTime(1_000)
    }
    throw new Error(`Not done within ${ms / 1_000} seconds of the worker's timers.`)
  }
  return { worker, until, deliveries: (type: RenderQueueJob["type"]) => deliveries.get(type) ?? 0 }
}

/** Where an export stands, read without asking for it. */
const read = { render: false } as const

// Reproduce each by trying its job again without its bound in RenderWorker.onExecutionError, as
// `if (true) return retry(...)`: the job is delivered again each backoff, a sandbox each time, and
// nothing ever says it failed.
describe("a video's job whose every render fails, in a running worker", () => {
  test("tries a segment VIDEO_SEGMENT_JOB.attempts times, then fails its export", async () => {
    jest.useFakeTimers()
    spyOn(console, "error").mockImplementation(() => {})
    const { host, sixb, version, queues, exportJob, assemble, claimable } = await setup(
      new ClosedSandboxes()
    )
    const job = await exportJob()
    await assemble(job)
    const [intro] = segmentsOf(await claimable())
    if (!intro) throw new Error("Expected the intro's segment.")
    // Its stills, asked for when the video was published, are not under test here.
    jest.setSystemTime(Date.now() + VIDEO_STILLS_JOB.settleMs)
    await claimable()

    // The intro is asked for again, alone: the worker delivers it until it gives up.
    const { worker, until, deliveries } = await runWorker(host)
    await queues.renders.enqueue({
      projectId,
      jobs: [{ id: intro.id, replace: true, type: intro.type, payload: intro.payload }],
    })
    await until(
      async () => (await sixb.artifacts.video(version.artifactId, read))?.status === "failed",
      VIDEO_SEGMENT_JOB.attempts * VIDEO_SEGMENT_JOB.backoffMs
    )
    expect(await sixb.artifacts.video(version.artifactId, read)).toEqual({
      status: "failed",
      reason: "Scene 'intro' could not be rendered. Try again in a moment.",
    })
    expect(deliveries("artifact.video.segment.requested")).toBe(VIDEO_SEGMENT_JOB.attempts)

    await worker.stop()
    jest.setSystemTime(Date.now() + VIDEO_EXPORT_JOB.waitMs)
    expect(await claimable()).toEqual([])
  })

  test("tries an export VIDEO_EXPORT_JOB.attempts times, then says it could not be put together", async () => {
    jest.useFakeTimers()
    spyOn(console, "error").mockImplementation(() => {})
    const { host, sixb, version, queues, exportJob, claimable, artifacts } = await setup(
      new ClosedSandboxes()
    )
    // Every segment is rendered: what is left is joining them, in a sandbox.
    const job = await exportJob()
    const file = version.files[0]?.file
    if (!file) throw new Error("Expected a file.")
    for (const segment of videoExportPlan(job.payload).segments) {
      await artifacts().putVideoRender({ projectId, key: segment.key, file, createdAt: new Date() })
    }
    jest.setSystemTime(Date.now() + VIDEO_STILLS_JOB.settleMs)
    await claimable()

    const { worker, until, deliveries } = await runWorker(host)
    await queues.renders.enqueue({
      projectId,
      jobs: [{ id: job.id, replace: true, type: job.type, payload: job.payload }],
    })
    await until(
      async () => (await sixb.artifacts.video(version.artifactId, read))?.status === "failed",
      VIDEO_EXPORT_JOB.attempts * VIDEO_EXPORT_JOB.backoffMs
    )
    expect(await sixb.artifacts.video(version.artifactId, read)).toEqual({
      status: "failed",
      reason: "It could not be put together. Try again in a moment.",
    })
    expect(deliveries("artifact.video.export.requested")).toBe(VIDEO_EXPORT_JOB.attempts)

    await worker.stop()
    jest.setSystemTime(Date.now() + VIDEO_EXPORT_JOB.waitMs)
    expect(await claimable()).toEqual([])
  })

  test("tries the stills VIDEO_STILLS_JOB.attempts times, then keeps why for each", async () => {
    jest.useFakeTimers()
    spyOn(console, "error").mockImplementation(() => {})
    const { host, version, claimable, artifacts } = await setup(new ClosedSandboxes())
    const record = await artifacts().getVersion({
      projectId,
      artifactId: version.artifactId,
      version: version.version,
    })
    if (!record) throw new Error("Expected the version.")
    const keys = (await missingVideoStills(artifacts(), record)).map(({ key }) => key)
    const kept = () => artifacts().listVideoRenders({ projectId, keys })

    // What publishing asked for: its stills, once the video rests.
    const { worker, until, deliveries } = await runWorker(host)
    await until(
      async () => (await kept()).length === keys.length,
      VIDEO_STILLS_JOB.settleMs + VIDEO_STILLS_JOB.attempts * VIDEO_STILLS_JOB.backoffMs
    )
    expect((await kept()).map((each) => "failure" in each && each.failure)).toEqual(
      keys.map(() => "It could not be snapshotted.")
    )
    expect(deliveries("artifact.video.stills.requested")).toBe(VIDEO_STILLS_JOB.attempts)

    await worker.stop()
    jest.setSystemTime(Date.now() + VIDEO_EXPORT_JOB.waitMs)
    expect(await claimable()).toEqual([])
  })
})
