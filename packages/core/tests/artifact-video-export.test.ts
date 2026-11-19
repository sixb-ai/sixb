import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { ArtifactFile, Principal, SandboxFactory } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import type { VideoOutline } from "../src/artifacts/outline"
import { readVideoComposition } from "../src/artifacts/video/composition"
import {
  type VideoExportSource,
  videoExportJobId,
  videoExportKeys,
  videoExportPlan,
} from "../src/artifacts/video/export"
import { videoSegmentIndex, videoSegmentRender } from "../src/artifacts/video/project"
import {
  VIDEO_STILLS_JOB,
  videoPoster,
  videoStillKey,
  videoStills,
  videoStillsJobId,
} from "../src/artifacts/video/stills"
import { emptyGrantIndex } from "../src/authorization/types"
import { inferFileMediaType } from "../src/blob-storage/internal"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A video exports to one MP4 joined from segments kept under their own keys: each scene's frames,
// from the frame it starts on to the frame the next one starts on, and the whole video's sound.
// Asking for it reads what is kept, and asks the render worker for the rest.

const alice: Principal = { type: "user", id: "alice" }

const scene = (id: string, body = `<h1>${id}</h1>`) =>
  `<template>\n  <div data-composition-id="${id}" data-width="1920" data-height="1080">${body}</div>\n</template>\n`

const host = (id: string, start: string, duration: string) =>
  `<div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${start}" data-duration="${duration}"></div>`

const MUSIC = '<audio id="music" src="media/music.m4a" data-start="0" data-duration="7"></audio>'

/** A title, a demo over a clip, and an outro that fades in over the demo's last half second. */
const index = (outroStart = "demo - 0.5") =>
  `<!doctype html>\n<html><body>\n<div data-composition-id="main" data-width="1920" data-height="1080" data-duration="7">\n${[
    host("intro", "0", "2"),
    host("demo", "intro", "3"),
    host("outro", outroStart, "2.5"),
    MUSIC,
  ].join("\n")}\n</div>\n</body></html>\n`

/** Its outro shows the logo another artifact holds. */
const launch = (logo: string): Readonly<Record<string, string>> => ({
  "index.html": index(),
  "scenes/intro.html": scene("intro"),
  "scenes/demo.html": scene("demo", '<video src="media/clip.mp4" muted playsinline></video>'),
  "scenes/outro.html": scene("outro", `<img src="artifact:${logo}/logo.png" alt="">`),
  "media/clip.mp4": "clip",
  "media/music.m4a": "music",
})

const forbidden = async (): Promise<never> => {
  throw new Error("Expected no sandbox: asking for an export never creates one.")
}
const sandboxes: SandboxFactory = { supportsRequestCredentials: true, create: forbidden }

function setup(options: { readonly sandboxes?: boolean } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "videos",
    ontology: [],
    ...deps,
    ...(options.sandboxes === false ? {} : { sandboxes }),
  })
  const sixb = createTestSixb(host, {
    authorization: { principal: alice, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
  })

  const files = async (contents: Readonly<Record<string, string>>) => {
    const list: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      const fileName = path.split("/").at(-1) ?? path
      const bytes = new TextEncoder().encode(body)
      list.push({
        path,
        file: await deps.blobStorage.put({
          body: bytes,
          fileName,
          mediaType: inferFileMediaType(fileName, bytes),
        }),
      })
    }
    return list
  }
  const publish = async (contents: Readonly<Record<string, string>>, title = "Launch") =>
    sixb.artifacts.create({ kind: "video", title, files: await files(contents) })
  /** A logo in an artifact of its own, and the launch film that shows it. */
  const withLogo = async () => {
    const { version } = await sixb.artifacts.create({
      kind: "file",
      title: "Logo",
      files: await files({ "logo.png": "logo" }),
    })
    return {
      logo: version.artifactId,
      logoFile: (version.files[0] as ArtifactFile).file,
      LAUNCH: launch(version.artifactId),
    }
  }

  /** The jobs the render worker would claim now, each done once claimed. */
  const claimable = async () => {
    const claims = await deps.queues.renders.claim({
      projectId: "videos",
      workerId: "test",
      limit: 20,
    })
    for (const { job, leaseId } of claims) {
      await deps.queues.renders.complete({ projectId: "videos", jobId: job.id, leaseId })
    }
    return claims.map(({ job }) => job)
  }
  const storage = () => {
    const kept = deps.storage.artifacts
    if (!kept) throw new Error("Expected artifact storage.")
    return kept
  }
  return { ...deps, sixb, files, publish, withLogo, claimable, storage }
}

/** The source of an export of a published video, its addresses resolved as `media` says. */
const sourceOf = (
  version: {
    readonly outline: unknown
    readonly files: readonly ArtifactFile[]
    readonly references: VideoExportSource["references"]
  },
  media: VideoExportSource["media"] = []
): VideoExportSource => ({
  outline: version.outline as VideoOutline,
  files: version.files,
  references: version.references,
  media,
})

describe("a video's export plan", () => {
  test("cuts the video where each scene starts, from frame 0 to its last frame", async () => {
    const { publish, withLogo } = setup()
    const { LAUNCH } = await withLogo()
    const { version } = await publish(LAUNCH)
    const plan = videoExportPlan(sourceOf(version))

    // 7 seconds at 30 frames a second; the outro starts at 4.5 seconds, over the demo.
    expect(plan.frames).toBe(210)
    expect(plan.segments.map(({ key: _key, ...segment }) => segment)).toEqual([
      { kind: "scene", scene: "intro", startFrame: 0, endFrame: 60 },
      { kind: "scene", scene: "demo", startFrame: 60, endFrame: 135 },
      { kind: "scene", scene: "outro", startFrame: 135, endFrame: 210 },
      { kind: "sound" },
    ])
    expect(new Set(videoExportKeys(plan)).size).toBe(5)
  })

  test("renders a scene that starts with another within the other's segment", async () => {
    const { publish, withLogo } = setup()
    const { LAUNCH } = await withLogo()
    const { version } = await publish({ ...LAUNCH, "index.html": index("intro") })
    const plan = videoExportPlan(sourceOf(version))

    expect(
      plan.segments.map((segment) => (segment.kind === "scene" ? segment.scene : "sound"))
    ).toEqual(["intro", "demo", "sound"])
    // The demo is listed first: the outro renders within its segment.
    expect(plan.segments.at(1)).toMatchObject({ startFrame: 60, endFrame: 210 })
  })

  // Reproduce by keying each segment with every scene's render key: the edited intro changes them
  // all.
  test("keeps every segment but the edited scene's, and mixes the sound again", async () => {
    const { publish, withLogo } = setup()
    const { LAUNCH } = await withLogo()
    const before = videoExportPlan(sourceOf((await publish(LAUNCH)).version))
    const after = videoExportPlan(
      sourceOf(
        (await publish({ ...LAUNCH, "scenes/intro.html": scene("intro", "<h1>Hi</h1>") })).version
      )
    )

    const changed = after.segments.filter(
      (segment, index) => segment.key !== before.segments[index]?.key
    )
    expect(changed.map((segment) => (segment.kind === "scene" ? segment.scene : "sound"))).toEqual([
      "intro",
      "sound",
    ])
    expect(after.key).not.toBe(before.key)

    // A copy of the video, another artifact, exports to the same MP4.
    expect(videoExportPlan(sourceOf((await publish(LAUNCH, "Copy")).version)).key).toBe(before.key)
  })

  // Reproduce by leaving `resolved` out of a segment's key: the outro keeps its key over another
  // logo.
  test("renders again the scenes that play what an address resolves to, once it changes", async () => {
    const { publish, files, withLogo } = setup()
    const { LAUNCH, logo } = await withLogo()
    const { version } = await publish(LAUNCH)
    const [first, other] = await files({ "a.png": "logo", "b.png": "another logo" })
    const resolved = (file: ArtifactFile | undefined) =>
      videoExportPlan(
        sourceOf(version, [
          { address: `artifact:${logo}/logo.png`, ...(file ? { file: file.file } : {}) },
        ])
      )

    const before = resolved(first)
    const after = resolved(other)
    const keys = (plan: typeof before) => plan.segments.map((segment) => segment.key)
    // The outro plays the logo, and the demo is on screen with it.
    expect(keys(after).map((key, index) => key === keys(before)[index])).toEqual([
      true,
      false,
      false,
      false,
    ])
    // An address the caller cannot read resolves to nothing, another export.
    expect(resolved(undefined).key).not.toBe(before.key)
  })
})

describe("a segment's project", () => {
  const composition = () => {
    const read = readVideoComposition(index(), (path) => launch("art_k3m9q2x7tp")[path])
    if ("error" in read) throw new Error(read.error)
    return read.composition
  }

  test("starts at frame 0 when no scene on screen started before it", () => {
    const render = videoSegmentRender(
      composition(),
      { scene: "demo", startFrame: 60, endFrame: 135 },
      false
    )
    expect(render).toEqual({ scenes: ["demo", "outro"], shiftFrames: 60, from: 0, to: 75 })

    const text = videoSegmentIndex(index(), composition(), render)
    expect(text).not.toContain('id="intro"')
    expect(text).toContain(
      'id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="0"'
    )
    expect(text).toContain(
      'id="outro" data-composition-id="outro" data-composition-src="scenes/outro.html" data-start="2.5"'
    )
    expect(text).toContain('data-height="1080" data-duration="2.5"')
    // The soundtrack stays: HyperFrames loads it, and the segment drops what it mixes.
    expect(text).toContain(MUSIC)
  })

  // Reproduce by moving the project to the segment's start whatever starts before it: the demo's
  // host would start at -1.5 seconds, which HyperFrames reads as 0.
  test("renders a range when a scene on screen started before it, or the root moves", () => {
    expect(
      videoSegmentRender(composition(), { scene: "outro", startFrame: 135, endFrame: 210 }, false)
    ).toEqual({ scenes: ["demo", "outro"], shiftFrames: 60, from: 75, to: 150 })
    expect(
      videoSegmentRender(composition(), { scene: "demo", startFrame: 60, endFrame: 135 }, true)
    ).toEqual({ scenes: ["demo", "outro"], shiftFrames: 0, from: 60, to: 135 })
  })
})

describe("sixb.artifacts.video()", () => {
  // Reproduce by leaving requestVideoExport out of video(): nothing is asked, and it renders forever.
  test("asks for the export once, with what the version holds, and says how far it has come", async () => {
    const { sixb, publish, claimable, storage, withLogo } = setup()
    const { LAUNCH, logo, logoFile } = await withLogo()
    const { version } = await publish(LAUNCH)
    await claimable()

    const asked = await sixb.artifacts.video(version.artifactId)
    expect(asked).toEqual({
      status: "rendering",
      progress: { ready: 0, total: 4, assembling: false },
    })
    await sixb.artifacts.video(version.artifactId)

    const plan = videoExportPlan(
      sourceOf(version, [{ address: `artifact:${logo}/logo.png`, file: logoFile }])
    )
    const jobs = await claimable()
    expect(jobs.map((job) => [job.id, job.type])).toEqual([
      [videoExportJobId(plan.key), "artifact.video.export.requested"],
    ])
    expect(jobs[0]?.payload).toMatchObject({
      artifactId: version.artifactId,
      version: 1,
      title: "Launch",
      key: plan.key,
      files: version.files,
      // What its addresses resolve to, as Alice reads them.
      media: [{ address: `artifact:${logo}/logo.png`, file: logoFile }],
    })

    // Two segments rendered; read without asking.
    for (const segment of plan.segments.slice(0, 2)) {
      await storage().putVideoRender({
        projectId: "videos",
        key: segment.key,
        file: (version.files[0] as ArtifactFile).file,
        createdAt: new Date(),
      })
    }
    expect(await sixb.artifacts.video(version.artifactId, { render: false })).toEqual({
      status: "rendering",
      progress: { ready: 2, total: 4, assembling: false },
    })
    expect(await claimable()).toEqual([])
  })

  test("answers ready with the MP4, and failed with why until asked to retry", async () => {
    const { sixb, publish, claimable, storage, files, withLogo } = setup()
    const { LAUNCH, logo, logoFile } = await withLogo()
    const { version } = await publish(LAUNCH)
    const plan = videoExportPlan(
      sourceOf(version, [{ address: `artifact:${logo}/logo.png`, file: logoFile }])
    )
    const [mp4] = await files({ "launch.mp4": "mp4" })
    if (!mp4) throw new Error("Expected a file.")

    const outro = plan.segments.at(2)
    await storage().putVideoRender({
      projectId: "videos",
      key: outro?.key ?? "",
      failure: "Scene 'outro' could not be rendered. Try again in a moment.",
      createdAt: new Date(),
    })
    await claimable()
    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "failed",
      reason: "Scene 'outro' could not be rendered. Try again in a moment.",
    })
    expect(await claimable()).toEqual([])

    // Reproduce by leaving clearVideoRenderFailures out of requestVideoExport: the retry answers
    // failed again.
    expect(await sixb.artifacts.video(version.artifactId, { retry: true })).toEqual({
      status: "rendering",
      progress: { ready: 0, total: 4, assembling: false },
    })
    const [job] = await claimable()
    expect(job?.payload).toMatchObject({ key: plan.key, retry: true })
    expect(
      await storage().listVideoRenders({ projectId: "videos", keys: videoExportKeys(plan) })
    ).toEqual([])

    await storage().putVideoRender({
      projectId: "videos",
      key: plan.key,
      file: mp4.file,
      createdAt: new Date(),
    })
    expect(await sixb.artifacts.video(version.artifactId)).toEqual({
      status: "ready",
      file: mp4.file,
      durationMs: 7000,
      sizeBytes: 3,
    })
  })

  test("refuses what is not a video, and a project without sandboxes", async () => {
    const { sixb, files } = setup()
    const page = await sixb.artifacts.create({
      kind: "page",
      title: "Notes",
      files: await files({ "index.html": "<h1>Notes</h1>" }),
    })
    const refused = await sixb.artifacts.video(page.version.artifactId).catch((error) => error)
    expect(refused).toBeInstanceOf(ArtifactRequestError)
    expect(refused.code).toBe("invalid_artifact")
    expect(await sixb.artifacts.video("art_nothere00")).toBeNull()

    const bare = setup({ sandboxes: false })
    const { version } = await bare.publish((await bare.withLogo()).LAUNCH)
    const unavailable = await bare.sixb.artifacts.video(version.artifactId).catch((error) => error)
    expect(unavailable.code).toBe("video_unavailable")
    // Read without asking, it says where it stands.
    expect(await bare.sixb.artifacts.video(version.artifactId, { render: false })).toMatchObject({
      status: "rendering",
    })
  })
})

describe("a video's stills", () => {
  afterEach(() => setSystemTime())

  // Reproduce by leaving requestVideoStills out of the artifacts runtime's requestPreviews.
  test("are asked for when a version is published, once it rests, until each scene has one", async () => {
    const { publish, claimable, storage, files, withLogo } = setup()
    const { LAUNCH, logo, logoFile } = await withLogo()
    const { version } = await publish(LAUNCH)
    const outline = version.outline as VideoOutline

    const stillsOf = (jobs: Awaited<ReturnType<typeof claimable>>, artifactId: string) =>
      jobs.filter((job) => job.id === videoStillsJobId(artifactId))
    expect(stillsOf(await claimable(), version.artifactId)).toEqual([])
    setSystemTime(new Date(Date.now() + VIDEO_STILLS_JOB.settleMs))
    const [asked] = stillsOf(await claimable(), version.artifactId)
    expect(asked?.payload).toEqual({
      artifactId: version.artifactId,
      version: 1,
      updatedAt: version.updatedAt.toISOString(),
      media: [{ address: `artifact:${logo}/logo.png`, file: logoFile }],
    })

    const [jpeg] = await files({ "still.jpg": "jpeg" })
    if (!jpeg) throw new Error("Expected a file.")
    for (const each of outline.scenes) {
      await storage().putVideoRender({
        projectId: "videos",
        key: videoStillKey(each),
        file: jpeg.file,
        createdAt: new Date(),
      })
    }

    // A copy keeps the scenes as they were: nothing is missing, nothing is asked.
    const copy = await publish(LAUNCH, "Copy")
    setSystemTime(new Date(Date.now() + 2 * VIDEO_STILLS_JOB.settleMs))
    expect(stillsOf(await claimable(), copy.version.artifactId)).toEqual([])
  })

  // Reproduce by leaving the poster out of videoStills: it is never snapshotted.
  test("include the poster at the instant the root names, else the first scene's", async () => {
    const { publish, withLogo } = setup()
    const { LAUNCH } = await withLogo()
    const posed = (seconds?: string) =>
      seconds === undefined
        ? LAUNCH
        : {
            ...LAUNCH,
            "index.html": (LAUNCH["index.html"] ?? "").replace(
              'data-duration="7"',
              `data-duration="7" data-poster="${seconds}"`
            ),
          }
    const outlineOf = async (seconds?: string) =>
      (await publish(posed(seconds))).version.outline as VideoOutline

    const plain = await outlineOf()
    expect(videoStills(plain).map(({ scene, atMs }) => [scene, atMs])).toEqual([
      ["intro", 1000],
      ["demo", 3500],
      ["outro", 5750],
    ])
    expect(videoPoster(plain)?.key).toBe(
      videoStillKey(plain.scenes[0] as VideoOutline["scenes"][0])
    )

    // 5 seconds in, the outro has started over the demo: its segment holds the instant.
    const posted = await outlineOf("5")
    const poster = videoPoster(posted)
    expect(poster).toMatchObject({ scene: "outro", atMs: 5000 })
    expect(videoStills(posted).slice(0, 3)).toEqual(videoStills(plain))
    expect(videoStills(posted).at(3)).toEqual(poster)
    expect(videoPoster(await outlineOf("6"))?.key).not.toBe(poster?.key)
  })
})
