import { afterEach, describe, expect, jest, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
import { FRAME_CDN_ALLOWLIST } from "@sixb/core/internal/artifacts/frames"
import { BOARD_PREVIEW_JOB } from "@sixb/core/internal/artifacts/publish"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import type { ArtifactPreviewsRequestedQueueJob } from "@sixb/core/queues"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { renderBoardPreviews } from "../src/board-previews"
import { RenderWorker } from "../src/worker"

const projectId = "previews"
const alice = { type: "user", id: "alice" } as const

/**
 * The project's sandboxes, real bash on this host, whose browser is the picture script's report:
 * each board it is asked to picture is pictured in every theme, each picture holding its board and
 * mode. What each picture served the boards' queries with is kept.
 */
class PicturingSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  /** What each picture served the boards' queries with: each status, and each answer by name. */
  readonly served: Record<string, unknown>[] = []
  /** The board pages each picture opened, by path, as the frame serves them. */
  readonly opened: Record<string, string>[] = []
  destroyed = 0
  /** Resolves each time a sandbox is destroyed, which ends a job's render. */
  private onDestroy: (() => void) | undefined

  destroyedOnce(): Promise<void> {
    return new Promise((resolve) => {
      this.onDestroy = resolve
    })
  }

  async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    this.created.push(options)
    const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create()
    const run = sandbox.runCommand.bind(sandbox)
    const destroy = sandbox.destroy.bind(sandbox)

    return Object.assign(sandbox, {
      runCommand: async (...[command, args, runOptions]: Parameters<Sandbox["runCommand"]>) => {
        if (!(args?.at(-1) ?? "").includes("picture.cjs")) return run(command, args, runOptions)
        const report = picture(
          join(sandbox.workingDirectory, "canvas"),
          join(sandbox.workingDirectory, "pictures"),
          this
        )
        return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "", durationMs: 0 }
      },
      destroy: async () => {
        await destroy()
        this.destroyed += 1
        this.onDestroy?.()
      },
    })
  }
}

function picture(site: string, out: string, sandboxes: PicturingSandboxes) {
  const statuses = JSON.parse(readFileSync(join(site, "__sixb/queries.json"), "utf8")) as Record<
    string,
    number
  >
  sandboxes.served.push({
    statuses,
    ...Object.fromEntries(
      Object.keys(statuses).map((name) => [
        name,
        JSON.parse(readFileSync(join(site, "__sixb/queries", `${name}.json`), "utf8")),
      ])
    ),
  })

  const boards = JSON.parse(readFileSync(join(out, "boards.json"), "utf8")) as {
    readonly id: string
    readonly file: string
  }[]
  sandboxes.opened.push(
    Object.fromEntries(boards.map(({ file }) => [file, readFileSync(join(site, file), "utf8")]))
  )
  const themes = Object.keys(JSON.parse(readFileSync(join(out, "themes.json"), "utf8")))
  mkdirSync(join(out, "boards"), { recursive: true })
  const pictures = boards.flatMap((board) =>
    themes.flatMap((theme) =>
      (["full", "small"] as const).map((size) => {
        const path = join(out, "boards", `${board.id}.${theme}.${size === "full" ? "png" : "webp"}`)
        writeFileSync(path, `${board.id} ${theme}${size === "small" ? " small" : ""}`)
        return { board: board.id, theme, size, path }
      })
    )
  )
  return { pictures, unpictured: [], stalls: [] }
}

const workers: RenderWorker[] = []
afterEach(async () => {
  jest.setSystemTime()
  await Promise.all(workers.splice(0).map((worker) => worker.stop()))
})

function setup(options: { readonly sandboxes?: PicturingSandboxes } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    queues: new InMemoryQueues(),
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    ...(options.sandboxes ? { sandboxes: options.sandboxes } : {}),
  })

  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )

  /** Alice's canvas of two boards, as she saves it in the app. */
  const canvas = async () =>
    createTestSixb(host, {
      authorization: { principal: alice, groupIds: [], roleIds: [], grants: emptyGrantIndex() },
    }).artifacts.create({
      kind: "canvas",
      title: "Onboarding",
      files: await put({
        "canvas.json": JSON.stringify({
          items: ["welcome", "region"].map((id, index) => ({
            id,
            type: "board",
            file: `boards/${id}.html`,
            x: index * 480,
            y: 0,
            w: 390,
            h: 844,
          })),
        }),
        "boards/welcome.html": "<main><h1>Welcome</h1></main>",
        "boards/region.html": "<main><h1>Regions</h1></main>",
      }),
    })

  /** Each board's pictures, as `board theme: contents`. */
  const pictures = async (version: ArtifactVersionRecord) => {
    const outline = version.outline
    if (outline.kind !== "canvas") return []
    const boards = new Map(
      outline.items.flatMap((item) => (item.type === "board" ? [[item.renderKey, item.id]] : []))
    )
    const kept = await storage.artifacts.listBoardPreviews({
      projectId,
      renderKeys: [...boards.keys()].flatMap((key) => (key ? [key] : [])),
    })
    const read = async (blobId: string) => new Response(await blobStorage.open(blobId)).text()
    return (
      await Promise.all(
        kept.map(
          async ({ renderKey, theme, file }) =>
            `${boards.get(renderKey)} ${theme}: ${await read(file.blobId)}`
        )
      )
    ).sort()
  }

  const job = (version: ArtifactVersionRecord) => ({
    id: "job",
    projectId,
    createdAt: new Date().toISOString(),
    availableAt: new Date().toISOString(),
    attempt: 1,
    type: "artifact.previews.requested" as const,
    payload: {
      artifactId: version.artifactId,
      version: version.version,
      updatedAt: version.updatedAt.toISOString(),
    },
  })

  /** Renders a job in the project's sandboxes, or in `sandboxes`. */
  const render = (job: ArtifactPreviewsRequestedQueueJob, sandboxes?: PicturingSandboxes) =>
    renderBoardPreviews({
      host: {
        id: projectId,
        storage: host.storage,
        blobStorage: host.blobStorage,
        ...(sandboxes ? { sandboxes } : {}),
      },
      job,
      signal: new AbortController().signal,
    })

  return { host, storage, blobStorage, canvas, pictures, job, render }
}

describe("a canvas version's previews", () => {
  // Reproduce by writing the boards' own HTML in picture(): the pages open without the frame's kit
  // and runtime, unthemed, unlike what a reader sees.
  test("are rendered in a blank sandbox that reaches only the frame's CDNs, as the frame serves each board", async () => {
    const sandboxes = new PicturingSandboxes()
    const { canvas, pictures, job, render } = setup()
    const { version } = await canvas()

    await render(job(version), sandboxes)

    expect(await pictures(version)).toEqual([
      "region dark: region dark",
      "region dark: region dark small",
      "region light: region light",
      "region light: region light small",
      "welcome dark: welcome dark",
      "welcome dark: welcome dark small",
      "welcome light: welcome light",
      "welcome light: welcome light small",
    ])
    expect(sandboxes.opened[0]?.["boards/welcome.html"]).toContain(
      '<link rel="stylesheet" href="../__sixb/page.css"><script src="../__sixb/runtime.js" data-sixb-layout="page">'
    )
    expect(sandboxes.created).toMatchObject([
      {
        environment: {},
        network: {
          mode: "restricted",
          allow: FRAME_CDN_ALLOWLIST.map((origin) => ({ name: new URL(origin).hostname, origin })),
        },
      },
    ])
    expect(sandboxes.destroyed).toBe(1)

    // A second delivery finds nothing missing, and opens no sandbox.
    await render(job(version), sandboxes)
    expect(sandboxes.created).toHaveLength(1)
  })

  test("are left to the job of the version's next content once it is written again", async () => {
    // Reproduce by dropping the content check in renderBoardPreviews: the job then pictures what
    // the version holds now, with the query answers of the content it was asked for.
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, pictures, job, render } = setup()
    const { version } = await canvas()
    const asked = job(version)

    await host.storage.artifacts?.publish({
      projectId,
      artifactId: version.artifactId,
      kind: "canvas",
      version: {
        ...version,
        title: "Written again",
        updatedAt: new Date(version.updatedAt.getTime() + 60_000),
      },
    })
    await render(asked, sandboxes)

    expect(sandboxes.created).toEqual([])
    expect(await pictures(version)).toEqual([])
  })

  test("are still rendered once someone created the version, which keeps its content", async () => {
    // Reproduce by comparing the job's revision with the version's in renderBoardPreviews:
    // creating the version moves its revision, and the job asked for its content renders nothing.
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, pictures, job, render } = setup()
    const { version } = await canvas()
    const asked = job(version)

    const frozen = await host.storage.artifacts?.freeze({
      projectId,
      artifactId: version.artifactId,
      frozenAt: new Date(version.updatedAt.getTime() + 60_000),
      frozenBy: alice,
    })
    expect(frozen?.version.revision).toBe(version.revision + 1)
    await render(asked, sandboxes)

    expect(sandboxes.created).toHaveLength(1)
    expect(await pictures(version)).toHaveLength(8)
  })

  test("are left to the outlines in a project without sandboxes", async () => {
    const { canvas, pictures, job, render } = setup()
    const { version } = await canvas()

    await render(job(version))

    expect(await pictures(version)).toEqual([])
  })

  test("serve its boards the query answers the job carries, as the agent's check serves them", async () => {
    // Reproduce by leaving the job's answers unread: the boards are opened with every query
    // rejecting, as a reader the query fails for sees them.
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, job, render } = setup()
    const { version } = await canvas()

    // A version whose boards read a query, and its answer as its publisher read it.
    const query = { ...version.files[0], path: "queries/open.json" } as ArtifactFile
    const live = await host.storage.artifacts?.publish({
      projectId,
      artifactId: version.artifactId,
      kind: "canvas",
      version: { ...version, files: [...version.files, query], updatedAt: new Date() },
    })
    if (!live) throw new Error("Expected artifact storage.")
    const answers = {
      open: { result: { kind: "objects", objects: [{ primaryId: "inv_1" }], total: 1 } },
      overdue: { error: "Principal 'alice' is not allowed to view object type 'Invoice'." },
    }
    const body = new TextEncoder().encode(JSON.stringify(answers))
    const queries = await host.blobStorage.put({ body, mediaType: "application/json" })

    await render(
      { ...job(live.version), payload: { ...job(live.version).payload, queries } },
      sandboxes
    )

    expect(sandboxes.served).toEqual([
      {
        statuses: { open: 200, overdue: 409 },
        open: answers.open.result,
        overdue: { error: answers.overdue.error },
      },
    ])
  })

  test("picture only the boards that read no query when the job carries no answers", async () => {
    // Reproduce by picturing every board without answers: Regions is pictured with its query
    // rejecting, a page no reader ever sees.
    const sandboxes = new PicturingSandboxes()
    const { host, blobStorage, canvas, pictures, job, render } = setup()
    const { version } = await canvas()

    const [query, region, script] = await Promise.all(
      [
        ["queries/open.json", '{"kind":"start","objectTypeId":"Invoice"}'],
        ["boards/region.html", '<main><script>sixb.query("open")</script></main>'],
        ["boards/app.js", 'export const rows = () => sixb.query("open")'],
      ].map(async ([path = "", body = ""]) => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
    const publish = async (files: readonly ArtifactFile[]) => {
      const published = await host.storage.artifacts?.publish({
        projectId,
        artifactId: version.artifactId,
        kind: "canvas",
        version: { ...version, files, updatedAt: new Date() },
      })
      if (!published) throw new Error("Expected artifact storage.")
      return published.version
    }
    const welcomeOnly = [
      "welcome dark: welcome dark",
      "welcome dark: welcome dark small",
      "welcome light: welcome light",
      "welcome light: welcome light small",
    ]

    const live = await publish([
      ...version.files.filter((file) => file.path !== "boards/region.html"),
      query,
      region,
    ] as ArtifactFile[])
    await render(job(live), sandboxes)
    expect(await pictures(live)).toEqual(welcomeOnly)

    // A script beside the boards may be what any of them reads its query with: Regions, whose
    // own HTML names none, keeps its outline too.
    const scripted = await publish([...version.files, query, script] as ArtifactFile[])
    await render(job(scripted), sandboxes)
    expect(await pictures(scripted)).toEqual(welcomeOnly)
  })

  // Reproduce by enqueueing the job on the agents' lane in requestBoardPreviews: the render worker
  // never claims it, and the boards keep their outlines.
  test("are rendered by the render worker for a version saved in the app, from the renders lane", async () => {
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, pictures } = setup({ sandboxes })
    const worker = new RenderWorker(host)
    workers.push(worker)

    const rendered = sandboxes.destroyedOnce()
    const { version } = await canvas()
    // The job waits for the canvas to rest.
    jest.setSystemTime(new Date(Date.now() + BOARD_PREVIEW_JOB.settleMs))
    await worker.start()
    await rendered

    expect(await pictures(version)).toHaveLength(8)
  })
})
