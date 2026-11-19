import { describe, expect, test } from "bun:test"
import type { ArtifactFile, Principal, SandboxFactory } from "../src"
import { SixbHost } from "../src"
import { findMediaTranscriber } from "../src/artifacts/media/transcriber"
import { emptyGrantIndex } from "../src/authorization/types"
import type { TranscriptionModel } from "../src/models"
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
  // failed once never comes.
  test("derives again what failed when asked with retry, and nothing else", async () => {
    const { sixb, put, claimable, artifacts } = setup()
    const clip = await put("clip.mp4", "clip", "video/mp4")
    const { artifact } = await sixb.artifacts.create({ kind: "file", title: "Clip", files: [clip] })
    await claimable()
    const poster = { status: "ready", file: clip.file, atMs: 1000 } as const
    const unavailable = { status: "unavailable", reason: "No transcription model." } as const
    const failed = { status: "failed", reason: "FFmpeg could not make it." } as const
    const kept = {
      projectId: "media",
      digest: clip.file.digest,
      parts: {
        probe: { status: "ready", durationMs: 1000, container: "mov,mp4,m4a,3gp,3g2,mj2" },
        proxy: failed,
        poster,
        filmstrip: failed,
        waveform: { status: "ready", file: clip.file },
        cuts: { status: "ready", atMs: [] },
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
    expect(retried?.parts).toMatchObject({
      proxy: pending,
      filmstrip: pending,
      poster,
      transcript: unavailable,
    })
    const [stored] = await artifacts().listMedia({
      projectId: "media",
      digests: [clip.file.digest],
    })
    expect(stored?.parts.proxy).toEqual(pending)
    expect((await claimable()).map(({ id }) => id)).toEqual([
      `art_media_${clip.file.digest.slice(7)}`,
    ])

    // Nothing failed any more: asking again with retry asks nothing more of the worker.
    await artifacts().putMedia({
      ...kept,
      parts: { ...kept.parts, proxy: { status: "ready", file: clip.file }, filmstrip: unavailable },
    })
    await sixb.artifacts.media(artifact.id, { path: "clip.mp4", retry: true })
    expect(await claimable()).toEqual([])
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
