import { describe, expect, test } from "bun:test"
import type { ArtifactFile, ArtifactMediaProbe, Principal, SandboxFactory } from "../src"
import { SixbHost } from "../src"
import {
  MEDIA_JOB,
  MEDIA_PROXY_PARAM,
  mediaJobBudget,
  mediaProxyReference,
  requestedMediaProxy,
} from "../src/artifacts/media/media"
import { findMediaTranscriber } from "../src/artifacts/media/transcriber"
import { emptyGrantIndex } from "../src/authorization/types"
import type { TranscriptionModel } from "../src/models"
import type { ArtifactMediaRecord } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// What Sixb derives of a video or a sound is asked for when a version holding it is published,
// once for every file with its bytes, and read through the artifact by whoever reads it.

const alice: Principal = { type: "user", id: "alice" }
const bob: Principal = { type: "user", id: "bob" }

const forbidden = async (): Promise<never> => {
  throw new Error("Expected no sandbox: asking for derivatives never creates one.")
}
const sandboxes: SandboxFactory = { supportsRequestCredentials: true, create: forbidden }

function setup(
  options: { readonly sandboxes?: boolean; readonly transcription?: TranscriptionModel } = {}
) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "media",
    ontology: [],
    ...deps,
    ...(options.sandboxes === false ? {} : { sandboxes }),
    ...(options.transcription
      ? { models: { audio: { transcription: [options.transcription] } } }
      : {}),
  })
  const as = (principal: Principal) =>
    createTestSixb(host, {
      authorization: { principal, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
    })
  const put = async (path: string, body: string, mediaType: string): Promise<ArtifactFile> => ({
    path,
    file: await deps.blobStorage.put({
      body: new TextEncoder().encode(body),
      fileName: path.split("/").at(-1) ?? path,
      mediaType,
    }),
  })
  /** The jobs the render worker would claim now, each done once claimed. */
  const claimable = async () => {
    const claims = await deps.queues.renders.claim({
      projectId: "media",
      workerId: "test",
      limit: 10,
    })
    for (const { job, leaseId } of claims) {
      await deps.queues.renders.complete({ projectId: "media", jobId: job.id, leaseId })
    }
    return claims.map(({ job }) => ({ id: job.id, type: job.type, payload: job.payload }))
  }
  const artifacts = () => {
    const kept = deps.storage.artifacts
    if (!kept) throw new Error("Expected artifact storage.")
    return kept
  }
  return { ...deps, host, sixb: as(alice), as, put, claimable, artifacts }
}

const pending = { status: "pending" } as const

/** What is derived of a 12 s clip at 720p, every part ready but the poster, which failed. */
function derived(digest: string): ArtifactMediaRecord {
  const file = {
    blobId: `blob_${"b".repeat(64)}`,
    digest: `sha256:${"b".repeat(64)}`,
    sizeBytes: 5,
    mediaType: "video/mp4",
  } as const
  return {
    projectId: "media",
    digest,
    parts: {
      probe: probe(),
      proxy: { status: "ready", file },
      poster: { status: "failed", reason: "FFmpeg could not make it." },
      filmstrip: {
        status: "ready",
        file,
        intervalMs: 1000,
        count: 12,
        columns: 10,
        width: 160,
        height: 90,
      },
      waveform: { status: "ready", file },
      cuts: { status: "ready", atMs: [] },
      transcript: { status: "ready", file },
    },
    attempts: 1,
    updatedAt: new Date(),
  }
}

function probe(video: Partial<NonNullable<ArtifactMediaProbe["video"]>> = {}, durationMs = 12_000) {
  return {
    status: "ready",
    durationMs,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264", width: 1280, height: 720, rotation: 0, fps: 30, ...video },
  } as const
}

function transcriptionModel(): TranscriptionModel {
  return {
    providerId: "test",
    modelId: "transcriber",
    definition: {
      kind: "transcription",
      providerId: "test",
      modelId: "transcriber",
      maxInputBytes: 1024,
    },
    async transcribe() {
      return { output: { text: "Hello there." } }
    },
  }
}

describe("what is derived of a media", () => {
  // Reproduce by leaving requestArtifactMedia out of the artifacts runtime's requestPreviews:
  // nothing is asked when a clip is published.
  test("is asked for once for every file that holds its bytes, of any kind", async () => {
    const { sixb, put, claimable, artifacts } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const voice = await put("media/voice.m4a", "voice", "audio/mp4")

    await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    // A deck's clip and a sound beside it, one of them published twice.
    const deck = await sixb.artifacts.create({
      kind: "slides",
      title: "Pitch",
      files: [
        await put(
          "index.html",
          '<!doctype html><section class="slide"><video src="clip.mp4"></video></section>',
          "text/html"
        ),
        { path: "clip.mp4", file: clip.file },
        voice,
        { path: "media/voice-again.m4a", file: voice.file },
      ],
    })

    expect(await claimable()).toEqual([
      {
        id: `art_media_${clip.file.digest.slice(7)}`,
        type: "artifact.media.requested",
        payload: { file: clip.file },
      },
      {
        id: `art_media_${voice.file.digest.slice(7)}`,
        type: "artifact.media.requested",
        payload: { file: voice.file },
      },
    ])

    // Kept, the clip is asked for no more, wherever it is published again.
    await artifacts().putMedia({
      projectId: "media",
      digest: clip.file.digest,
      parts: {
        probe: pending,
        proxy: pending,
        poster: pending,
        filmstrip: pending,
        waveform: pending,
        cuts: pending,
        transcript: pending,
      },
      attempts: 1,
      updatedAt: new Date(),
    })
    await sixb.artifacts.update(deck.artifact.id, {
      kind: "slides",
      title: "Pitch",
      files: [...deck.version.files, { path: "clip-copy.mp4", file: clip.file }],
    })
    expect((await claimable()).map(({ payload }) => payload)).toEqual([{ file: voice.file }])
  })

  test("is asked for what a video's scenes play", async () => {
    const { sixb, put, claimable } = setup()
    const clip = await put("media/clip.mp4", "clip", "video/mp4")

    await sixb.artifacts.create({
      kind: "video",
      title: "Launch film",
      files: [
        await put(
          "index.html",
          '<!doctype html><div data-composition-id="main" data-width="1920" data-height="1080"><div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="0" data-duration="3"></div></div>',
          "text/html"
        ),
        await put(
          "scenes/demo.html",
          '<template><div data-composition-id="demo"><video src="media/clip.mp4" muted></video></div></template>',
          "text/html"
        ),
        clip,
      ],
    })

    expect(await claimable()).toEqual([
      {
        id: `art_media_${clip.file.digest.slice(7)}`,
        type: "artifact.media.requested",
        payload: { file: clip.file },
      },
    ])
  })

  // Reproduce by leaving borrowedRecordings out of requestPreviews in execution.ts: the film asks
  // for nothing, and its frame plays the borrowed clip's original for good.
  test("is asked for what a video plays from another artifact, if nothing asked for it yet", async () => {
    const { sixb, put, claimable } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const footage = await sixb.artifacts.create({ kind: "file", title: "Footage", files: [clip] })
    // Its job is lost before it derives anything, as for a clip published before media were.
    await claimable()

    await sixb.artifacts.create({
      kind: "video",
      title: "Launch film",
      files: [
        await put(
          "index.html",
          '<!doctype html><div data-composition-id="main" data-width="1920" data-height="1080"><div id="demo" data-composition-id="demo" data-composition-src="scenes/demo.html" data-start="0" data-duration="3"></div></div>',
          "text/html"
        ),
        await put(
          "scenes/demo.html",
          `<template><div data-composition-id="demo"><video src="artifact:${footage.artifact.id}/clip.mp4" muted></video></div></template>`,
          "text/html"
        ),
      ],
    })

    expect(await claimable()).toEqual([
      {
        id: `art_media_${clip.file.digest.slice(7)}`,
        type: "artifact.media.requested",
        payload: { file: clip.file },
      },
    ])
  })

  test("is not asked for in a project without sandboxes, nor for what is no media", async () => {
    const { sixb, put, claimable } = setup({ sandboxes: false })
    await sixb.artifacts.create({
      kind: "file",
      title: "Clip",
      files: [await put("clip.mp4", "clip", "video/mp4")],
    })
    expect(await claimable()).toEqual([])

    const { sixb: other, put: otherPut, claimable: otherClaimable } = setup()
    await other.artifacts.create({
      kind: "file",
      title: "Notes",
      files: [await otherPut("notes.txt", "notes", "text/plain")],
    })
    expect(await otherClaimable()).toEqual([])
  })

  // Reproduce by returning null from media() when nothing is kept: a clip published before media
  // were derived would never be.
  test("reads as pending until derived, asking for one never asked for", async () => {
    const { sixb, put, claimable, artifacts } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const { artifact } = await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    await claimable()

    const asked = await sixb.artifacts.media(artifact.id, { path: "clip.mp4" })
    expect(asked).toEqual({
      version: 1,
      path: "clip.mp4",
      file: clip.file,
      parts: {
        probe: pending,
        proxy: pending,
        poster: pending,
        filmstrip: pending,
        waveform: pending,
        cuts: pending,
        transcript: pending,
      },
    })
    expect(await claimable()).toHaveLength(1)

    const parts = {
      ...asked?.parts,
      poster: { status: "ready", file: clip.file, atMs: 1000 },
      proxy: { status: "failed", reason: "FFmpeg could not make it." },
    } as const
    await artifacts().putMedia({
      projectId: "media",
      digest: clip.file.digest,
      parts: { ...asked!.parts, ...parts },
      attempts: 2,
      updatedAt: new Date(),
    })
    expect((await sixb.artifacts.media(artifact.id, { path: "clip.mp4" }))?.parts).toMatchObject({
      poster: { status: "ready", atMs: 1000 },
      proxy: { status: "failed", reason: "FFmpeg could not make it." },
    })
    expect(await claimable()).toEqual([])
  })

  // Reproduce by returning what is kept at once in media(), whatever `retry` says: a proxy that
  // failed once never comes. And by resetting failed parts alone in retryArtifactMedia: cuts a
  // sandbox without FFmpeg could not find stay unavailable once it has it.
  test("derives again what failed, and what the project lacked, when asked with retry", async () => {
    const { sixb, put, claimable, artifacts } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const { artifact } = await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    await claimable()
    const poster = { status: "ready", file: clip.file, atMs: 1000 } as const
    const unavailable = { status: "unavailable", reason: "No transcription model." } as const
    const failed = { status: "failed", reason: "FFmpeg could not make it." } as const
    const lacking = { status: "unavailable", reason: "No FFmpeg.", lacks: "sandbox_tools" } as const
    const kept = {
      projectId: "media",
      digest: clip.file.digest,
      parts: {
        probe: { status: "ready", durationMs: 1000, container: "mov,mp4,m4a,3gp,3g2,mj2" },
        proxy: failed,
        poster,
        filmstrip: failed,
        waveform: { status: "ready", file: clip.file },
        cuts: lacking,
        transcript: unavailable,
      },
      attempts: 3,
      updatedAt: new Date(),
    } as const
    await artifacts().putMedia(kept)

    // Read without retry, a failure says why, and nothing is asked.
    expect((await sixb.artifacts.media(artifact.id, { path: "clip.mp4" }))?.parts.proxy).toEqual(
      failed
    )
    expect(await claimable()).toEqual([])

    const retried = await sixb.artifacts.media(artifact.id, { path: "clip.mp4", retry: true })
    // One by one: Bun's toMatchObject checks an expected object it meets twice only once.
    expect(retried?.parts.proxy).toEqual(pending)
    expect(retried?.parts.filmstrip).toEqual(pending)
    expect(retried?.parts.cuts).toEqual(pending)
    expect(retried?.parts).toMatchObject({ poster, transcript: unavailable })
    const [stored] = await artifacts().listMedia({
      projectId: "media",
      digests: [clip.file.digest],
    })
    // A new ask: its attempts start over.
    expect(stored).toMatchObject({ attempts: 0, parts: { proxy: pending } })
    expect((await claimable()).map(({ id }) => id)).toEqual([
      `art_media_${clip.file.digest.slice(7)}`,
    ])

    // Nothing failed any more: asking again with retry asks nothing more of the worker.
    await artifacts().putMedia({
      ...kept,
      parts: {
        ...kept.parts,
        proxy: { status: "ready", file: clip.file },
        filmstrip: unavailable,
        cuts: { status: "ready", atMs: [] },
      },
    })
    await sixb.artifacts.media(artifact.id, { path: "clip.mp4", retry: true })
    expect(await claimable()).toEqual([])
  })

  // Reproduce by leaving the transcript out of refreshArtifactMedia: a clip published before the
  // project had a transcription model is never transcribed.
  test("asks for a transcript once the project has a transcription model", async () => {
    const { sixb, put, claimable, artifacts } = setup({ transcription: transcriptionModel() })
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const { artifact } = await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    await claimable()
    await artifacts().putMedia({
      ...derived(clip.file.digest),
      parts: {
        ...derived(clip.file.digest).parts,
        transcript: {
          status: "unavailable",
          reason: "This project has no transcription model.",
          lacks: "transcription_model",
        },
      },
      attempts: 3,
    })

    const media = await sixb.artifacts.media(artifact.id, { path: "clip.mp4" })

    expect(media?.parts.transcript).toEqual(pending)
    const [stored] = await artifacts().listMedia({
      projectId: "media",
      digests: [clip.file.digest],
    })
    expect(stored).toMatchObject({ attempts: 0, parts: { transcript: pending } })
    expect(await claimable()).toHaveLength(1)
  })

  // Reproduce by leaving isMediaLost out of refreshArtifactMedia: a job its queue lost leaves what
  // is pending pending for good.
  test("asks again for what is pending once its job is lost, its attempts kept", async () => {
    const { sixb, put, claimable, artifacts } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const { artifact } = await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    await claimable()
    const waiting = {
      ...derived(clip.file.digest),
      parts: { ...derived(clip.file.digest).parts, transcript: pending },
      attempts: 2,
    }

    // A job still within its time: nothing is asked.
    await artifacts().putMedia({ ...waiting, updatedAt: new Date() })
    await sixb.artifacts.media(artifact.id, { path: "clip.mp4" })
    expect(await claimable()).toEqual([])

    // One silent for longer than an attempt takes, on publish as on a read.
    await artifacts().putMedia({ ...waiting, updatedAt: new Date(Date.now() - 4 * 60 * 60_000) })
    await sixb.artifacts.media(artifact.id, { path: "clip.mp4" })
    await sixb.artifacts.create({ kind: "file", title: "Again", files: [clip] })
    expect(await claimable()).toHaveLength(1)
    const [stored] = await artifacts().listMedia({
      projectId: "media",
      digests: [clip.file.digest],
    })
    expect(stored?.attempts).toBe(2)
  })

  test("is unavailable in a project without sandboxes", async () => {
    const { sixb, put, claimable } = setup({ sandboxes: false })
    const { artifact } = await sixb.artifacts.create({
      kind: "file",
      title: "Song",
      files: [await put("song.mp3", "song", "audio/mpeg")],
    })

    const media = await sixb.artifacts.media(artifact.id, { path: "song.mp3" })
    expect(media?.parts.transcript).toEqual({
      status: "unavailable",
      reason: "This project has no sandboxes to derive it in.",
      lacks: "sandboxes",
    })
    expect(await claimable()).toEqual([])
  })

  // Reproduce by reading the record in media() before reading the version as the caller: anyone
  // who knows an artifact's id reads what is derived of its clip.
  test("is read through the artifact, by whoever reads it", async () => {
    const { sixb, as, put } = setup()
    const { artifact } = await sixb.artifacts.create({
      kind: "file",
      title: "Clip",
      files: [await put("clip.mp4", "clip", "video/mp4")],
    })

    expect(await as(bob).artifacts.media(artifact.id, { path: "clip.mp4" })).toBeNull()
    const missing = await sixb.artifacts
      .media(artifact.id, { path: "nothing.mp4" })
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ code: "invalid_artifact" })
  })
})

describe("a media's transcript", () => {
  // Reproduce by leaving `artifacts.transcribeMedia` out of isKernelOperationType: the kernel
  // authority refuses the operation, and nothing is transcribed.
  test("is the project's model's, recorded as the kernel operation that derives it", async () => {
    const heard: { readonly mediaType: string; readonly bytes: number }[] = []
    const { host, storage } = setup({
      transcription: {
        providerId: "test",
        modelId: "transcriber",
        definition: {
          kind: "transcription",
          providerId: "test",
          modelId: "transcriber",
          maxInputBytes: 1024,
        },
        async transcribe(request) {
          heard.push({ mediaType: request.mediaType, bytes: request.audio.byteLength })
          return {
            output: {
              text: "Hello there.",
              language: "en",
              words: [{ text: "Hello", startMs: 0, endMs: 400 }],
            },
            usage: { audioDurationMs: 1200 },
          }
        },
      },
    })
    const transcriber = findMediaTranscriber(host)
    expect(transcriber?.model).toEqual({ maxInputBytes: 1024 })

    const digest = `sha256:${"a".repeat(64)}`
    const output = await transcriber?.transcribe({
      digest,
      jobId: `art_media_${"a".repeat(64)}`,
      attempt: 1,
      audio: { data: new Uint8Array([1, 2, 3]), mediaType: "audio/mpeg" },
      signal: new AbortController().signal,
    })

    expect(output).toEqual({
      text: "Hello there.",
      language: "en",
      words: [{ text: "Hello", startMs: 0, endMs: 400 }],
    })
    expect(heard).toEqual([{ mediaType: "audio/mpeg", bytes: 3 }])
    const execution = await storage.executions.getById({
      projectId: "media",
      id: `exec_media_${"a".repeat(64)}`,
    })
    expect(execution).toMatchObject({
      executor: { type: "kernel", operation: { type: "artifacts.transcribeMedia", digest } },
      authorizationRef: { type: "kernel" },
      requesterGroupIds: [],
    })
    expect(execution?.requestedBy).toBeUndefined()
  })

  test("has no model in a project that configures none", () => {
    const { host } = setup()
    expect(findMediaTranscriber(host)?.model).toBeNull()
  })
})

describe("the time a media takes to derive", () => {
  // Reproduce by giving every media `MEDIA_JOB.maxTimeoutMs`: a lost job of a short clip is found
  // lost only two hours on, and a hung FFmpeg holds a sandbox as long.
  test("scales with what the proxy decodes, within the longest a job has", () => {
    const clip = mediaJobBudget(probe())
    const film = mediaJobBudget(
      probe({ width: 3840, height: 2160, fps: 60, codec: "hevc" }, 20 * 60_000)
    )

    expect(clip.timeoutMs).toBeLessThan(MEDIA_JOB.maxTimeoutMs / 3)
    expect(film.proxyMs).toBeGreaterThan(20 * clip.proxyMs)
    expect(film.timeoutMs).toBe(MEDIA_JOB.maxTimeoutMs)
    expect(mediaJobBudget(undefined).timeoutMs).toBe(MEDIA_JOB.maxTimeoutMs)
    expect(clip.deriveMs + clip.transcribeMs).toBeLessThan(clip.timeoutMs)
  })
})

describe("a frame's address of a media's proxy", () => {
  const original: ArtifactFile = {
    path: "media/launch clip.mov",
    file: { blobId: `blob_${"a".repeat(64)}`, digest: `sha256:${"a".repeat(64)}`, sizeBytes: 9 },
  }
  const media = derived(original.file.digest)

  // Reproduce by naming the proxy by the original's path alone: a page that loaded the original
  // gets the proxy's bytes under the same address, and its player stops.
  test("names the proxy's bytes, and nothing before it is ready", () => {
    const reference = mediaProxyReference(original, media)
    expect(reference).toBe(`media/launch%20clip.mov?${MEDIA_PROXY_PARAM}=${"b".repeat(16)}`)

    expect(mediaProxyReference(original, undefined)).toBeNull()
    expect(
      mediaProxyReference(original, { ...media, parts: { ...media.parts, proxy: pending } })
    ).toBeNull()
    // What is derived of other bytes is not this file's.
    expect(mediaProxyReference(original, derived(`sha256:${"c".repeat(64)}`))).toBeNull()
  })

  test("is served as the proxy it names, the original without one, and nothing else", () => {
    const named = new URLSearchParams({ [MEDIA_PROXY_PARAM]: "b".repeat(16) })
    expect(requestedMediaProxy(original, media, named)).toMatchObject({ mediaType: "video/mp4" })
    expect(requestedMediaProxy(original, media, new URLSearchParams())).toBeUndefined()

    const other = new URLSearchParams({ [MEDIA_PROXY_PARAM]: "d".repeat(16) })
    expect(requestedMediaProxy(original, media, other)).toBeNull()
    expect(requestedMediaProxy(original, undefined, named)).toBeNull()
  })
})
