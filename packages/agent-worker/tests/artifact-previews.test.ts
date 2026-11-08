import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
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
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import type { ArtifactVersionRecord } from "@sixb/core/storage"
import { createTestSixb } from "@sixb/core/testing"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
import { renderArtifactPreviews } from "../src/artifact-previews"
import { AgentWorker } from "../src/worker"

const projectId = "previews"
const alice = { type: "user", id: "alice" } as const

/**
 * The project's sandboxes, real bash on this host, whose layout check is the browser's report: each
 * board it is asked to picture is pictured in every theme, each picture holding its board and mode.
 */
class PicturingSandboxes implements Pick<SandboxFactory, "create" | "supportsRequestCredentials"> {
  readonly supportsRequestCredentials = true
  readonly created: CreateSandboxOptions[] = []
  /** What each check served the boards' queries with: each status, and each answer by name. */
  readonly served: Record<string, unknown>[] = []
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
        const output = runOptions?.env?.SIXB_CHECK_OUT
        return output === undefined
          ? run(command, args, runOptions)
          : {
              exitCode: 0,
              stdout: `${JSON.stringify(check(output, this.served))}\n`,
              stderr: "",
              durationMs: 0,
            }
      },
      destroy: async () => {
        await destroy()
        this.destroyed += 1
        this.onDestroy?.()
      },
    })
  }
}

function check(output: string, served: Record<string, unknown>[]) {
  const statuses = JSON.parse(readFileSync(join(output, "queries.json"), "utf8")) as Record<
    string,
    number
  >
  served.push({
    statuses,
    ...Object.fromEntries(
      Object.keys(statuses).map((name) => [
        name,
        JSON.parse(readFileSync(join(output, "queries", `${name}.json`), "utf8")),
      ])
    ),
  })

  const boards = JSON.parse(readFileSync(join(output, "boards.json"), "utf8")) as {
    readonly id: string
    readonly pictured: boolean
  }[]
  const themes = Object.keys(JSON.parse(readFileSync(join(output, "themes.json"), "utf8")))
  const previews = boards
    .filter((board) => board.pictured)
    .flatMap((board) =>
      themes.map((theme) => {
        const path = join(output, `${board.id}.${theme}.png`)
        writeFileSync(path, `${board.id} ${theme}`)
        return { board: board.id, theme, path }
      })
    )
  return { layout: "canvas", problems: [], errors: [], screenshots: [], previews }
}

function setup(options: { readonly sandboxes?: PicturingSandboxes } = {}) {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const queues = new InMemoryQueues()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    storage,
    blobStorage,
    queues,
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
  const canvas = async (extra: Record<string, string> = {}) =>
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
        ...extra,
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
    type: "agent.artifact-previews.requested" as const,
    payload: { artifactId: version.artifactId, version: version.version },
  })

  return { host, storage, blobStorage, queues, canvas, pictures, job }
}

describe("a canvas version's previews", () => {
  test("are rendered in a blank sandbox with no network, which is destroyed after", async () => {
    // Reproduce by rendering in the run's ephemeral sandbox: the job has no run credential to
    // give it, and the API on its network serves nothing a board needs.
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, pictures, job } = setup()
    const { version } = await canvas()
    const render = () =>
      renderArtifactPreviews({
        host: { id: projectId, storage: host.storage, blobStorage: host.blobStorage, sandboxes },
        job: job(version),
        signal: new AbortController().signal,
      })

    await render()

    expect(await pictures(version)).toEqual([
      "region dark: region dark",
      "region light: region light",
      "welcome dark: welcome dark",
      "welcome light: welcome light",
    ])
    expect(sandboxes.created).toMatchObject([{ environment: {}, network: { mode: "none" } }])
    expect(sandboxes.destroyed).toBe(1)

    // A second delivery finds nothing missing, and opens no sandbox.
    await render()
    expect(sandboxes.created).toHaveLength(1)
  })

  test("are left to the outlines in a project without sandboxes", async () => {
    const { host, canvas, pictures, job } = setup()
    const { version } = await canvas()

    await renderArtifactPreviews({
      host: { id: projectId, storage: host.storage, blobStorage: host.blobStorage },
      job: job(version),
      signal: new AbortController().signal,
    })

    expect(await pictures(version)).toEqual([])
  })

  test("serve its boards the query answers the job carries, as the check serves them", async () => {
    // Reproduce by leaving the job's answers unread: the boards are opened with every query
    // rejecting, as a reader the query fails for sees them.
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, job } = setup()
    const { version } = await canvas()

    // A version whose boards read a query, and its answer as its publisher read it.
    const query = { ...version.files[0], path: "queries/open.json" } as ArtifactFile
    const live = await host.storage.artifacts?.publish({
      projectId,
      artifactId: version.artifactId,
      kind: "canvas",
      version: { ...version, files: [...version.files, query], createdAt: new Date() },
    })
    if (!live) throw new Error("Expected artifact storage.")
    const answers = {
      open: { result: { kind: "objects", objects: [{ primaryId: "inv_1" }], total: 1 } },
      overdue: { error: "Principal 'alice' is not allowed to view object type 'Invoice'." },
    }
    const body = new TextEncoder().encode(JSON.stringify(answers))
    const queries = await host.blobStorage.put({ body, mediaType: "application/json" })

    await renderArtifactPreviews({
      host: { id: projectId, storage: host.storage, blobStorage: host.blobStorage, sandboxes },
      job: { ...job(live.version), payload: { ...job(live.version).payload, queries } },
      signal: new AbortController().signal,
    })

    expect(sandboxes.served).toEqual([
      {
        statuses: { open: 200, overdue: 409 },
        open: answers.open.result,
        overdue: { error: answers.overdue.error },
      },
    ])
  })

  test("are rendered by the agent worker for a version a person saved in the app", async () => {
    const sandboxes = new PicturingSandboxes()
    const { host, canvas, pictures } = setup({ sandboxes })
    const worker = new AgentWorker(host, {})

    const rendered = sandboxes.destroyedOnce()
    const { version } = await canvas()
    await worker.start()
    try {
      await rendered
    } finally {
      await worker.stop()
    }

    expect(await pictures(version)).toHaveLength(4)
  })
})
