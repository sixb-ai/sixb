import { afterEach, describe, expect, jest, test } from "bun:test"
import type {
  ArtifactFile,
  ArtifactVersionRecord,
  FileRef,
  Principal,
  SandboxFactory,
} from "../src"
import { SixbHost } from "../src"
import { BOARD_PREVIEW_JOB, BOARD_PREVIEW_WAIT_MS } from "../src/artifacts/canvas-display"
import type { CanvasOutline } from "../src/artifacts/outline"
import {
  boardPreviewStatuses,
  boardRenderKey,
  MAX_BOARD_PREVIEW_BYTES,
  missingBoardPreviews,
  requestBoardPreviews,
  storeBoardPreviews,
} from "../src/artifacts/publish/previews"
import { emptyGrantIndex } from "../src/authorization/types"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const alice: Principal = { type: "user", id: "alice" }
const bob: Principal = { type: "user", id: "bob" }

const forbidden = async (): Promise<never> => {
  throw new Error("Must not create a sandbox")
}
/** A project's sandboxes, which only the agent worker uses: publishing never creates one. */
const sandboxes: SandboxFactory = { supportsRequestCredentials: true, create: forbidden }

const board = (id: string, x = 0, w = 390) => ({
  id,
  type: "board",
  file: `boards/${id}.html`,
  x,
  y: 0,
  w,
  h: 844,
})

function setup(options: { readonly sandboxes?: boolean } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "previews",
    ontology: [],
    ...deps,
    ...(options.sandboxes === false ? {} : { sandboxes }),
  })
  const as = (principal: Principal) =>
    createTestSixb(host, {
      authorization: { principal, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
    })

  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> => {
    const files: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      files.push({
        path,
        file: await deps.blobStorage.put({
          body: new TextEncoder().encode(body),
          fileName: path.split("/").at(-1) ?? path,
        }),
      })
    }
    return files
  }

  const png = (seed: string) =>
    deps.blobStorage.put({
      body: new TextEncoder().encode(`png ${seed}`),
      fileName: `${seed}.png`,
      mediaType: "image/png",
    })
  const webp = (seed: string) =>
    deps.blobStorage.put({
      body: new TextEncoder().encode(`webp ${seed}`),
      fileName: `${seed}.webp`,
      mediaType: "image/webp",
    })

  /** A board's pictures in these modes, at both sizes, as its renderer hands them over. */
  const pictures = async (board: string, themes: readonly ("light" | "dark")[]) =>
    (
      await Promise.all(
        themes.map(async (theme) => [
          { board, theme, size: "full" as const, file: await png(`${board}-${theme}`) },
          { board, theme, size: "small" as const, file: await webp(`${board}-${theme}`) },
        ])
      )
    ).flat()

  /** The jobs the agent worker would claim now. */
  const claimable = async () =>
    (await deps.queues.agents.claim({ projectId: "previews", workerId: "test", limit: 10 })).map(
      ({ job }) => ({ id: job.id, type: job.type, payload: job.payload })
    )

  return { deps, host, as, put, png, webp, pictures, claimable }
}

const CANVAS = JSON.stringify({ items: [board("welcome"), board("region", 480)] })
const BOARDS = {
  "boards/welcome.html": "<main><h1>Welcome</h1></main>",
  "boards/region.html": "<main><h1>Regions</h1></main>",
  "boards/shared.css": "h1 { letter-spacing: -0.02em }",
}

/** What asks for a static canvas's previews: it has no query to answer. */
function requester(deps: ReturnType<typeof setup>["deps"]) {
  return {
    storage: deps.storage.artifacts,
    queue: deps.queues.agents,
    blobStorage: deps.blobStorage,
    query: async (): Promise<never> => {
      throw new Error("A static canvas has no query.")
    },
  }
}

function keys(version: ArtifactVersionRecord): Record<string, string | undefined> {
  const outline = version.outline as CanvasOutline
  return Object.fromEntries(
    outline.items.flatMap((item) => (item.type === "board" ? [[item.id, item.renderKey]] : []))
  )
}

afterEach(() => {
  jest.useRealTimers()
})

describe("a board's render key", () => {
  const file = (path: string, seed: string): ArtifactFile => {
    const hex = seed.repeat(64).slice(0, 64)
    return { path, file: { blobId: `blob_${hex}`, digest: `sha256:${hex}`, sizeBytes: 1 } }
  }
  const files = [
    file("canvas.json", "0"),
    file("boards/welcome.html", "1"),
    file("boards/region.html", "2"),
    file("boards/shared.css", "3"),
  ]
  const boardFiles = new Set(["boards/welcome.html", "boards/region.html"])
  const welcome = { file: "boards/welcome.html", w: 390, h: 844 }
  const key = (overrides: Partial<Parameters<typeof boardRenderKey>[0]> = {}) =>
    boardRenderKey({
      board: welcome,
      files,
      boardFiles,
      author: alice,
      artifactId: "art_onboarding",
      ...overrides,
    })

  test("stays while nothing the board shows changes", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/)
    expect(key({ files: [...files].reverse() })).toBe(key())

    // Where the board sits, the other boards it does not show, and who saved the version: Bob
    // moving a note on Alice's canvas keeps every picture. Reproduce by keeping the author in a
    // static board's key: his save names every board anew.
    const moved = files.map((entry) =>
      entry.path === "canvas.json" || entry.path === "boards/region.html"
        ? file(entry.path, "9")
        : entry
    )
    expect(key({ files: moved })).toBe(key())
    expect(key({ author: bob })).toBe(key())
  })

  test("changes with its HTML, what it loads, its size, its theme, and its artifact", () => {
    const changed = (path: string) =>
      files.map((entry) => (entry.path === path ? file(path, "9") : entry))

    // Reproduce the artifact's by leaving it out: whoever may picture one artifact's boards hands
    // over a picture for the same board in another artifact, which they cannot change.
    const seen = new Set([
      key(),
      key({ files: changed("boards/welcome.html") }),
      key({ files: changed("boards/shared.css") }),
      key({ files: [...files, file("theme.json", "5")] }),
      key({ board: { ...welcome, w: 1280 } }),
      key({ board: { ...welcome, h: 900 } }),
      key({ artifactId: "art_copy" }),
    ])
    expect(seen.size).toBe(7)
  })

  test("names a live board's author, whose data it shows", () => {
    // Reproduce by leaving the author out: Bob's version shows readers the picture of Alice's
    // rows, not his.
    const live = [...files, file("queries/regions.json", "6")]
    expect(key({ files: live, author: bob })).not.toBe(key({ files: live }))
  })
})

describe("publishing a canvas", () => {
  test("names each board's picture, and keeps the names of boards it did not change", async () => {
    const { as, put } = setup()
    const first = await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS }),
    })
    expect(first.version.outline).toMatchObject({ themes: ["light", "dark"] })

    // A person moves a board and rewrites the other one in the app.
    const second = await as(alice).artifacts.publish(first.artifact.id, {
      kind: "canvas",
      title: "Onboarding",
      files: await put({
        "canvas.json": JSON.stringify({ items: [board("welcome", 40), board("region", 520)] }),
        ...BOARDS,
        "boards/region.html": "<main><h1>Regions, by city</h1></main>",
      }),
    })

    expect(keys(second.version).welcome).toBe(keys(first.version).welcome)
    expect(keys(second.version).region).not.toBe(keys(first.version).region)
  })

  test("pictures its boards only in the mode its theme.json pins", async () => {
    const { as, put } = setup()
    const published = await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS, "theme.json": '{"mode":"dark"}' }),
    })

    expect(published.version.outline).toMatchObject({ themes: ["dark"] })
  })

  test("asks the agent worker for its missing pictures, and for none it already has", async () => {
    const { deps, as, put, pictures, claimable } = setup()
    const first = await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS }),
    })

    const job = ({ revision, updatedAt }: { revision: number; updatedAt: Date }) => ({
      id: `art_previews_${first.artifact.id}_r${revision}`,
      type: "agent.artifact-previews.requested" as const,
      payload: { artifactId: first.artifact.id, version: 1, updatedAt: updatedAt.toISOString() },
    })
    expect(await claimable()).toEqual([job(first.version)])

    // Asking again for the same revision is the same job.
    await requestBoardPreviews(requester(deps), first.version)
    expect(await claimable()).toEqual([])

    // The worker rendered each board in both modes: moving one renders nothing.
    await storeBoardPreviews(
      { storage: deps.storage.artifacts, blobStorage: deps.blobStorage },
      first.version,
      [
        ...(await pictures("welcome", ["light", "dark"])),
        ...(await pictures("region", ["light", "dark"])),
      ]
    )
    await as(alice).artifacts.publish(first.artifact.id, {
      kind: "canvas",
      title: "Onboarding",
      files: await put({
        "canvas.json": JSON.stringify({ items: [board("welcome", 40), board("region", 520)] }),
        ...BOARDS,
      }),
    })
    expect(await claimable()).toEqual([])

    // Writing the open version again with one board changed asks for that board's pictures, in a
    // job of the new revision's. Reproduce by keying the job by version: it is the first job.
    const changed = await as(alice).artifacts.publish(first.artifact.id, {
      kind: "canvas",
      title: "Onboarding",
      files: await put({
        "canvas.json": CANVAS,
        ...BOARDS,
        "boards/region.html": "<main><h1>Regions, by city</h1></main>",
      }),
    })
    expect(changed.version.revision).toBe(3)
    expect(await claimable()).toEqual([job(changed.version)])
  })

  test("asks for nothing in a project without sandboxes, where nothing renders them", async () => {
    // Reproduce by asking whatever the project has: the job waits for a sandbox that never comes.
    const { as, put, claimable } = setup({ sandboxes: false })
    await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS }),
    })

    expect(await claimable()).toEqual([])
  })

  test("asks after the grace a publisher that renders its own pictures takes", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date("2026-11-08T10:00:00.000Z"))
    // Without sandboxes publishing asks for nothing, so only the request below is queued.
    const { deps, as, put, claimable } = setup({ sandboxes: false })
    const { version } = await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS }),
    })

    await requestBoardPreviews(requester(deps), version, { delayMs: BOARD_PREVIEW_JOB.graceMs })
    expect(await claimable()).toEqual([])

    jest.setSystemTime(new Date(Date.now() + BOARD_PREVIEW_JOB.graceMs))
    expect((await claimable()).map((job) => job.payload)).toEqual([
      { artifactId: version.artifactId, version: 1, updatedAt: version.updatedAt.toISOString() },
    ])
  })
})

describe("a board's pictures", () => {
  async function published() {
    const context = setup()
    const { version } = await context.as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await context.put({ "canvas.json": CANVAS, ...BOARDS }),
    })
    const store = (previews: Parameters<typeof storeBoardPreviews>[2]) =>
      storeBoardPreviews(
        { storage: context.deps.storage.artifacts, blobStorage: context.deps.blobStorage },
        version,
        previews
      )
    return { ...context, version, store }
  }

  test("are kept under each board's key, and are missing no more once both sizes are", async () => {
    const { deps, version, store, pictures, png } = await published()
    await store(await pictures("welcome", ["light"]))
    // A full picture without its small one is still missing: the renderer takes both.
    await store([{ board: "region", theme: "light", size: "full", file: await png("region") }])

    expect(
      (await missingBoardPreviews(deps.storage.artifacts, version)).map(
        ({ board, themes }) => `${board.id}: ${themes.join(", ")}`
      )
    ).toEqual(["welcome: dark", "region: light, dark"])
  })

  test("are each kept or refused alone: for a board or a mode the version lacks, another format, or past the limit", async () => {
    // Reproduce by refusing the whole hand-over for one picture: Welcome's light pictures, fine
    // as they are, are lost with the rest, and a board of a hundred keeps none for one too large.
    const { deps, version, store, pictures, png, webp } = await published()
    const picture = await png("welcome")
    const small = await webp("welcome")
    const welcome = { board: "welcome", theme: "dark" } as const
    const svg = await deps.blobStorage.put({
      body: new TextEncoder().encode("<svg/>"),
      mediaType: "image/svg+xml",
    })
    const unstored: FileRef = { ...picture, sizeBytes: picture.sizeBytes + 1 }
    const huge: FileRef = { ...picture, sizeBytes: MAX_BOARD_PREVIEW_BYTES + 1 }

    const refused = await store([
      ...(await pictures("welcome", ["light"])),
      { ...welcome, board: "pricing", size: "full", file: picture },
      { ...welcome, size: "full", file: svg },
      { ...welcome, size: "small", file: picture },
      { board: "region", theme: "light", size: "full", file: small },
      { board: "region", theme: "dark", size: "full", file: unstored },
      {
        board: "region",
        theme: "light",
        size: "small",
        file: { ...huge, mediaType: "image/webp" },
      },
    ])

    expect(
      refused.map(({ board, theme, size, reason }) => `${board} ${theme} ${size}: ${reason}`)
    ).toEqual([
      "pricing dark full: the version has no board 'pricing' to picture in dark mode",
      "welcome dark full: a full picture must be image/png",
      "welcome dark small: a small picture must be image/webp",
      "region light full: a full picture must be image/png",
      "region dark full: it is not stored",
      `region light small: it is ${MAX_BOARD_PREVIEW_BYTES + 1} bytes, past the ${MAX_BOARD_PREVIEW_BYTES} kept`,
    ])
    expect(
      (await missingBoardPreviews(deps.storage.artifacts, version)).map(
        ({ board, themes }) => `${board.id}: ${themes.join(", ")}`
      )
    ).toEqual(["welcome: dark", "region: light, dark"])
  })

  // Guard proof: leave the artifact out of boardRenderKey; the copy's boards are then pictured
  // by whatever was handed over for the original's.
  test("are an artifact's own: another with the same boards shares none of them", async () => {
    const { deps, as, put, version, store, pictures } = await published()
    await store([
      ...(await pictures("welcome", ["light", "dark"])),
      ...(await pictures("region", ["light", "dark"])),
    ])

    const same = await as(alice).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({ "canvas.json": CANVAS, ...BOARDS }),
    })

    expect(await missingBoardPreviews(deps.storage.artifacts, version)).toEqual([])
    expect(
      (await missingBoardPreviews(deps.storage.artifacts, same.version)).map(
        ({ board }) => board.id
      )
    ).toEqual(["welcome", "region"])
  })

  test("read as ready, pending while one may still come, and none past the wait", async () => {
    const { deps, version, store, pictures } = await published()
    await store(await pictures("welcome", ["light", "dark"]))
    const statuses = async (renders: boolean, now: Date) =>
      Object.fromEntries(
        await boardPreviewStatuses(deps.storage.artifacts, version, { renders, now })
      )

    expect(await statuses(true, version.createdAt)).toEqual({ welcome: "ready", region: "pending" })

    // Still pending while the worker's last attempt may run: its grace, each attempt to its
    // timeout, and the backoffs between. Reproduce with a wait of 15 minutes: the viewer stops
    // asking five minutes before the last attempt can end.
    const { graceMs, attempts, timeoutMs, backoffMs } = BOARD_PREVIEW_JOB
    const lastAttemptEnds = graceMs + attempts * timeoutMs + (attempts - 1) * backoffMs
    const during = new Date(version.createdAt.getTime() + lastAttemptEnds - 1)
    expect(await statuses(true, during)).toEqual({ welcome: "ready", region: "pending" })

    const past = new Date(version.createdAt.getTime() + BOARD_PREVIEW_WAIT_MS)
    expect(await statuses(true, past)).toEqual({ welcome: "ready", region: "none" })
    expect(await statuses(false, version.createdAt)).toEqual({ welcome: "ready", region: "none" })
  })
})
