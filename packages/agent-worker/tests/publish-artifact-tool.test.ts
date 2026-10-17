import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  AgentToolPublicError,
  InMemoryBlobStorage,
  InMemoryStorage,
  type JsonValue,
  type Principal,
} from "@sixb/core"
import { createTestAgentExecution } from "@sixb/core/testing"
import { materializeThreadArtifacts } from "../src/artifacts/materialize"
import { createPublishArtifactTools } from "../src/artifacts/publish-tool"
import { AgentExecutionLostError } from "../src/errors"
import { BUILT_IN_SKILLS } from "../src/skills/built-in"
import { AgentFileBudget } from "../src/tools/tool-files"
import { LocalBashSandbox } from "./helpers"

const projectId = "publish-tests"
const owner: Principal = { type: "user", id: "usr_owner" }
const run = { id: "run_1", threadId: "thr_1", executionToken: "exec_1" }
const context = { signal: new AbortController().signal, callId: "call", toolCallId: "call" }

let root: string
let storage: InMemoryStorage
let blobStorage: InMemoryBlobStorage

beforeEach(async () => {
  // realpath: on macOS the temporary directory sits behind the /var → /private/var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-publish-")))
  storage = new InMemoryStorage()
  blobStorage = new InMemoryBlobStorage()
  await storage.agents.threads.create({ id: run.threadId, projectId, ownerPrincipal: owner })
  const executionId = await createTestAgentExecution(storage, { projectId, runId: run.id })
  await storage.agents.runs.create({
    id: run.id,
    projectId,
    threadId: run.threadId,
    triggerMessageId: "msg_1",
    executionId,
    spec: { model: { provider: "test", modelId: "model" } },
  })
  await storage.agents.runs.start({
    projectId,
    id: run.id,
    execution: { token: run.executionToken, queueLeaseExpiresAt: new Date("2099-01-01") },
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}

type ToolOptions = { readonly budget?: AgentFileBudget; readonly executionToken?: string }

function tools(options: ToolOptions = {}) {
  const [create, version] = createPublishArtifactTools({
    projectId,
    storage,
    blobStorage,
    run: { ...run, executionToken: options.executionToken ?? run.executionToken },
    owner,
    budget: options.budget ?? new AgentFileBudget(),
    resolveSandbox: async () => ({ sandbox: new LocalBashSandbox(root) }),
  })
  return { create, version }
}

/** `publish_artifact`: a new artifact. */
async function publish(input: Record<string, unknown>, options?: ToolOptions): Promise<JsonValue> {
  const { create } = tools(options)
  return create.execute(create.parseInput(input), context)
}

/** `publish_artifact_version`: the next version of one. */
async function publishVersion(input: Record<string, unknown>): Promise<JsonValue> {
  const { version } = tools()
  return version.execute(version.parseInput(input), context)
}

async function refusal(
  input: Record<string, unknown>,
  which: "create" | "version" = "create"
): Promise<string> {
  const { create, version } = tools()
  try {
    if (which === "create") await create.execute(create.parseInput(input), context)
    else await version.execute(version.parseInput(input), context)
  } catch (error) {
    expect(error).toBeInstanceOf(AgentToolPublicError)
    return create.errorText(error)
  }
  throw new Error("Expected the publish to be refused.")
}

describe("publish_artifact", () => {
  test("publishes a directory as the thread's owner, from this run", async () => {
    write(
      "work/review/document.md",
      "# Q3 review\n\nRevenue grew.\n\n![Chart](figures/chart.svg)\n"
    )
    write("work/review/figures/chart.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
    write("work/review/.notes", "a working note")

    const output = await publish({ path: "work/review", kind: "document", title: "Q3 review" })

    expect(output).toMatchObject({ version: 1, kind: "document", title: "Q3 review", warnings: [] })
    const id = (output as { artifactId: string }).artifactId
    const artifact = await storage.artifacts.get({ projectId, id })
    expect(artifact?.owner).toEqual(owner)
    const version = await storage.artifacts.getVersion({ projectId, artifactId: id, version: 1 })
    expect(version?.files.map((file) => file.path)).toEqual(["document.md", "figures/chart.svg"])
    expect(version?.origin).toEqual({ threadId: run.threadId, runId: run.id })
    expect(version?.author).toEqual(owner)
    expect(tools().create.toModelOutput?.(output, context)).toEqual({
      type: "text",
      value: `Published "Q3 review" as artifact ${id}, version 1.\nTo change it, publish its next version with publish_artifact_version and this id.`,
    })
  })

  test("publishes one Markdown file as a document and any other file under its name", async () => {
    write("drafts/brief.md", "# Brief\n\nShort.\n")
    write("exports/regions.csv", "region,visits\nNorth,1284\n")

    const document = await publish({ path: "drafts/brief.md", kind: "document", title: "Brief" })
    const file = await publish({ path: "exports/regions.csv", kind: "file", title: "Regions" })

    for (const [output, path] of [
      [document, "document.md"],
      [file, "regions.csv"],
    ] as const) {
      const artifactId = (output as { artifactId: string }).artifactId
      const version = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
      expect(version?.files.map((entry) => entry.path)).toEqual([path])
    }
  })

  test("publishes the next version of an artifact the owner has, in its kind", async () => {
    write("work/review/document.md", "# Q3 review\n\nDraft.\n")
    write("exports/regions.csv", "region,visits\nNorth,1284\n")
    const review = (await publish({
      path: "work/review",
      kind: "document",
      title: "Q3 review",
    })) as {
      artifactId: string
    }
    const regions = (await publish({
      path: "exports/regions.csv",
      kind: "file",
      title: "Regions",
    })) as {
      artifactId: string
    }
    write("work/review/document.md", "# Q3 review\n\nFinal.\n")
    write("exports/regions.csv", "region,visits\nNorth,1300\n")

    expect(
      await publishVersion({ id: review.artifactId, path: "work/review", title: "Final" })
    ).toMatchObject({ artifactId: review.artifactId, version: 2, kind: "document", title: "Final" })
    // A file keeps its kind, so a single file publishes under its own name, not as a document.
    await publishVersion({ id: regions.artifactId, path: "exports/regions.csv", title: "Regions" })
    const regionsV2 = await storage.artifacts.getVersion({
      projectId,
      artifactId: regions.artifactId,
      version: 2,
    })
    expect(regionsV2?.files.map((file) => file.path)).toEqual(["regions.csv"])
  })

  test("refuses ids that are not an artifact of the owner's, and says how to create one", async () => {
    write("work/review/document.md", "# Q3 review\n\nDraft.\n")
    const shape =
      "[SixbAgentWorker] publish_artifact_version refused: id must be an artifact id such as art_k3m9q2x7tp. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact."
    // What a model sends when it means "no artifact yet".
    for (const id of [" ", "", "new", "null", "0", ".sixb-new"]) {
      expect(await refusal({ id, path: "work/review", title: "Q3" }, "version")).toBe(shape)
    }
    expect(
      await refusal({ id: "art_0000000000", path: "work/review", title: "Q3" }, "version")
    ).toBe(
      "[SixbAgentWorker] publish_artifact_version refused: there is no artifact 'art_0000000000'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact."
    )
  })

  test("says what to fix and stores nothing when the version is invalid", async () => {
    write("work/review/document.md", "# Q3 review\n\n![Chart](figures/missing.svg)\n")
    write("empty/.keep", "")

    expect(await refusal({ path: "work/review", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: document.md shows the image 'figures/missing.svg', which is not one of the artifact's files."
    )
    expect(await refusal({ path: "missing", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: there is no file or directory at 'missing'."
    )
    expect(await refusal({ path: "empty", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: 'empty' holds no files to publish."
    )
    expect(await refusal({ path: "../outside", kind: "document", title: "Q3" })).toContain(
      "path must stay inside the sandbox working directory"
    )
    expect((await storage.artifacts.list({ projectId })).artifacts).toEqual([])
  })

  test("counts what it stores against the run's file budget, and only what it published", async () => {
    write("work/review/document.md", "# Q3 review\n\nRevenue grew.\n")
    write("work/broken/document.md", "# Broken\n\n![Missing](missing.png)\n")
    const budget = new AgentFileBudget(1024)

    await expect(
      publish({ path: "work/broken", kind: "document", title: "Broken" }, { budget })
    ).rejects.toBeInstanceOf(AgentToolPublicError)
    expect(budget.reservedBytes).toBe(0)

    await publish({ path: "work/review", kind: "document", title: "Q3 review" }, { budget })
    expect(budget.reservedBytes).toBe("# Q3 review\n\nRevenue grew.\n".length)

    write("work/big/document.md", `# Big\n\n${"x".repeat(2048)}\n`)
    await expect(
      publish({ path: "work/big", kind: "document", title: "Big" }, { budget })
    ).rejects.toThrow("exceed the 1024-byte run limit")
  })

  test("publishes nothing once the run no longer owns its execution", async () => {
    write("work/review/document.md", "# Q3 review\n\nRevenue grew.\n")

    await expect(
      publish(
        { path: "work/review", kind: "document", title: "Q3 review" },
        { executionToken: "exec_stale" }
      )
    ).rejects.toBeInstanceOf(AgentExecutionLostError)

    // The run ends while its files are read: the commit is fenced too. Reproduce by removing
    // `assertRunIsCurrent` from the publish transaction; the ended run publishes.
    const [publisher] = createPublishArtifactTools({
      projectId,
      storage,
      blobStorage,
      run,
      owner,
      budget: new AgentFileBudget(),
      resolveSandbox: async () => {
        await storage.agents.runs.finish({
          projectId,
          id: run.id,
          executionToken: run.executionToken,
          status: "failed",
        })
        return { sandbox: new LocalBashSandbox(root) }
      },
    })
    await expect(
      publisher.execute(
        publisher.parseInput({ path: "work/review", kind: "document", title: "Q3 review" }),
        context
      )
    ).rejects.toBeInstanceOf(AgentExecutionLostError)
    expect((await storage.artifacts.list({ projectId })).artifacts).toEqual([])
  })

  test("refuses input outside its schema", () => {
    const { create, version } = tools()
    expect(() => create.parseInput({ path: "a", kind: "page", title: "A" })).toThrow(
      "kind must be one of document, sheet, slides, file"
    )
    expect(() =>
      create.parseInput({ path: "a", kind: "file", title: "A", id: "art_0000000000" })
    ).toThrow("unknown property 'id'")
    expect(() =>
      version.parseInput({ id: "art_0000000000", path: "a", kind: "file", title: "A" })
    ).toThrow("unknown property 'kind'")
  })
})

describe("the sixb-artifacts skill's examples", () => {
  test("publish as they are", async () => {
    // The skill describes what the publisher accepts; its examples prove it.
    const skill = BUILT_IN_SKILLS.find((candidate) => candidate.name === "sixb-artifacts")
    const examples = (skill?.files ?? []).filter((file) => file.path.startsWith("examples/"))
    for (const file of examples) write(file.path, String(file.contents))
    const directories = [
      ...new Set(examples.map((file) => file.path.split("/").slice(0, 3).join("/"))),
    ]
    expect(directories).toEqual([
      "examples/document/operations-review",
      "examples/document/incident-report",
      "examples/slides/q3-review",
      "examples/slides/launch-plan",
      "examples/sheet/service-metrics",
      "examples/sheet/parts-inventory",
    ])
    for (const directory of directories) {
      const kind = directory.split("/")[1] as "document" | "sheet" | "slides"
      expect(await publish({ path: directory, kind, title: directory })).toMatchObject({
        version: 1,
        kind,
        warnings: [],
      })
    }
  })
})

describe("materializeThreadArtifacts", () => {
  test("installs the thread's latest versions, newest first, within the byte budget", async () => {
    write("a/document.md", "# First\n\nOne.\n")
    write("b/document.md", "# Second\n\nTwo.\n")
    const first = (await publish({ path: "a", kind: "document", title: "First" })) as {
      artifactId: string
    }
    write("a/document.md", "# First\n\nOne, revised.\n")
    await publishVersion({ id: first.artifactId, path: "a", title: "First" })
    const second = (await publish({ path: "b", kind: "document", title: "Second" })) as {
      artifactId: string
    }

    const installed = await materializeThreadArtifacts({
      projectId,
      threadId: run.threadId,
      owner,
      storage: storage.artifacts,
      blobStorage,
      directory: ".sixb/agent/artifacts",
    })

    expect(JSON.parse(installed.manifestJson)).toEqual({
      artifacts: [
        {
          id: second.artifactId,
          kind: "document",
          title: "Second",
          version: 1,
          // Ready to copy: the Agent never works out a heading's slug.
          address: `artifact:${second.artifactId}`,
          pinned: `artifact:${second.artifactId}@1`,
          parts: [
            {
              address: `artifact:${second.artifactId}#second`,
              pinned: `artifact:${second.artifactId}@1#second`,
              name: "Second",
            },
          ],
          directory: `.sixb/agent/artifacts/${second.artifactId}`,
          files: ["document.md"],
        },
        {
          id: first.artifactId,
          kind: "document",
          title: "First",
          version: 2,
          address: `artifact:${first.artifactId}`,
          pinned: `artifact:${first.artifactId}@2`,
          parts: [
            {
              address: `artifact:${first.artifactId}#first`,
              pinned: `artifact:${first.artifactId}@2#first`,
              name: "First",
            },
          ],
          directory: `.sixb/agent/artifacts/${first.artifactId}`,
          files: ["document.md"],
        },
      ],
    })
    expect(
      installed.files.map((file) => [
        file.path,
        new TextDecoder().decode(file.contents as Uint8Array),
      ])
    ).toEqual([
      [`.sixb/agent/artifacts/${second.artifactId}/document.md`, "# Second\n\nTwo.\n"],
      [`.sixb/agent/artifacts/${first.artifactId}/document.md`, "# First\n\nOne, revised.\n"],
    ])

    // Past the budget, an older artifact is listed without its files.
    const bounded = await materializeThreadArtifacts({
      projectId,
      threadId: run.threadId,
      owner,
      storage: storage.artifacts,
      blobStorage,
      directory: ".sixb/agent/artifacts",
      maxBytes: "# Second\n\nTwo.\n".length,
    })
    expect(JSON.parse(bounded.manifestJson).artifacts[1]).toEqual({
      id: first.artifactId,
      kind: "document",
      title: "First",
      version: 2,
      address: `artifact:${first.artifactId}`,
      pinned: `artifact:${first.artifactId}@2`,
      parts: [
        {
          address: `artifact:${first.artifactId}#first`,
          pinned: `artifact:${first.artifactId}@2#first`,
          name: "First",
        },
      ],
      files: ["document.md"],
    })
    expect(bounded.files).toHaveLength(1)

    const elsewhere = await materializeThreadArtifacts({
      projectId,
      threadId: "thr_other",
      owner,
      storage: storage.artifacts,
      blobStorage,
      directory: ".sixb/agent/artifacts",
    })
    expect(JSON.parse(elsewhere.manifestJson)).toEqual({ artifacts: [] })
  })
})
