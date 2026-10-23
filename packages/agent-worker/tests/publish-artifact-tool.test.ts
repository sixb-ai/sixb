import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  AgentToolPublicError,
  AuthorizationError,
  defineMarking,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type JsonValue,
  link,
  type Principal,
  prop,
  SixbHost,
} from "@sixb/core"
import { emptyGrantIndex, type GrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestAgentExecution, createTestSixb } from "@sixb/core/testing"
import { type InstalledArtifacts, materializeThreadArtifacts } from "../src/artifacts/materialize"
import { createPublishArtifactTools } from "../src/artifacts/publish-tool"
import { AgentExecutionLostError } from "../src/errors"
import { BUILT_IN_SKILLS } from "../src/skills/built-in"
import { AgentFileBudget } from "../src/tools/tool-files"
import { LocalBashSandbox } from "./helpers"

const projectId = "publish-tests"
const owner: Principal = { type: "user", id: "usr_owner" }
const run = { id: "run_1", threadId: "thr_1", executionToken: "exec_1" }
const context = { signal: new AbortController().signal, callId: "call", toolCallId: "call" }

const financial = defineMarking("financial")

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [prop("id", "string", { primary: true, required: true }), prop("name", "string")],
})

/** The invoices the skill's live sheet example reads. */
const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("number", "string"),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("dueDate", "date", { query: { searchable: true, sortable: true } }),
    prop("amount", "double", { markings: [financial] }),
    prop("paid", "double"),
  ],
  links: [link("customer", Customer, { cardinality: "one" })],
})

/** What reading the invoices takes. */
const invoiceReader = { "view:object": new Set(["Invoice", "Customer"]) }

let root: string
let storage: InMemoryStorage
let blobStorage: InMemoryBlobStorage
let host: SixbHost

/**
 * What a turn asked for by this user reads of artifacts, by the project's one rule: signed in
 * with a session, as a person asking in the app is.
 */
function readerFor(
  user: Principal,
  grants: Partial<GrantIndex> = {},
  clearances?: ReadonlySet<string>
) {
  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: `session-${user.id}` },
      context: {
        principal: user,
        sessionId: `session-${user.id}`,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true, ...grants },
        ...(clearances ? { clearances } : {}),
      },
    },
  }).artifacts
}

/** A thread with a turn running in it, as `run` is in thr_1. */
async function startRun(threadId: string, threadOwner: Principal) {
  await storage.agents.threads.create({ id: threadId, projectId, ownerPrincipal: threadOwner })
  const started = { id: `run_${threadId}`, threadId, executionToken: `exec_${threadId}` }
  const executionId = await createTestAgentExecution(storage, { projectId, runId: started.id })
  await storage.agents.runs.create({
    id: started.id,
    projectId,
    threadId,
    triggerMessageId: `msg_${threadId}`,
    executionId,
    spec: { model: { provider: "test", modelId: "model" } },
  })
  await storage.agents.runs.start({
    projectId,
    id: started.id,
    execution: { token: started.executionToken, queueLeaseExpiresAt: new Date("2099-01-01") },
  })
  return started
}

beforeEach(async () => {
  // realpath: on macOS the temporary directory sits behind the /var → /private/var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-publish-")))
  storage = new InMemoryStorage()
  blobStorage = new InMemoryBlobStorage()
  host = new SixbHost({
    id: projectId,
    ontology: [Customer, Invoice],
    markings: [financial],
    storage,
    blobStorage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
  })
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

type ToolOptions = {
  readonly budget?: AgentFileBudget
  readonly executionToken?: string
  /** The run's install; each call is a run of its own without one. */
  readonly installed?: Promise<InstalledArtifacts>
  /** Who asked for the turn; the thread's owner when omitted. */
  readonly author?: Principal
  /** The turn that publishes; `run`, in thr_1, when omitted. */
  readonly run?: typeof run
  /** What the requester may do besides running the Agent. */
  readonly grants?: Partial<GrantIndex>
  /** The markings the requester is cleared for. */
  readonly clearances?: ReadonlySet<string>
  /** Changes the requester's view of artifacts, as their rights changing mid-turn would. */
  readonly reader?: (reader: ReturnType<typeof readerFor>) => void
}

/** What a run installs in its sandbox before it publishes. */
function install(
  options: { readonly maxBytes?: number; readonly requester?: Principal } = {}
): Promise<InstalledArtifacts> {
  const { requester, ...rest } = options
  return materializeThreadArtifacts({
    threadId: run.threadId,
    artifacts: readerFor(requester ?? owner),
    blobStorage,
    directory: ".sixb/agent/artifacts",
    manifestPath: ".sixb/agent/context/artifacts.json",
    ...rest,
  })
}

/**
 * The run's sandbox: a real bash in the directory, without the agent image's browser, so a deck's
 * layout check skips at once on any host. layout-check.test.ts runs the check itself.
 */
function sandbox(): LocalBashSandbox {
  const local = new LocalBashSandbox(root)
  const run = local.runCommand.bind(local)
  local.runCommand = async (command, args, options) =>
    options?.env?.SIXB_CHECK_DECK === undefined
      ? run(command, args, options)
      : { exitCode: 0, stdout: '{"skipped":"no_browser"}\n', stderr: "", durationMs: 0 }
  return local
}

/** The requester's view of artifacts, the one runtime its access rule is kept for. */
function requester(options: ToolOptions) {
  const reader = readerFor(options.author ?? owner, options.grants, options.clearances)
  options.reader?.(reader)
  return reader
}

function tools(options: ToolOptions = {}) {
  const [create, version] = createPublishArtifactTools({
    projectId,
    storage,
    artifacts: storage.artifacts,
    reader: requester(options),
    blobStorage,
    run: {
      ...(options.run ?? run),
      executionToken: options.executionToken ?? (options.run ?? run).executionToken,
    },
    owner,
    author: options.author ?? owner,
    budget: options.budget ?? new AgentFileBudget(),
    resolveSandbox: async () => ({ sandbox: sandbox() }),
    installed: options.installed ?? install({ requester: options.author ?? owner }),
  })
  return { create, version }
}

/** `publish_artifact`: a new artifact. */
async function publish(input: Record<string, unknown>, options?: ToolOptions): Promise<JsonValue> {
  const { create } = tools(options)
  return create.execute(create.parseInput(input), context)
}

/** `publish_artifact_version`: the next version of one. */
async function publishVersion(
  input: Record<string, unknown>,
  options?: ToolOptions
): Promise<JsonValue> {
  const { version } = tools(options)
  return version.execute(version.parseInput(input), context)
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8")
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

/** A document version published outside this run: a person's save in the app has no origin. */
async function publishElsewhere(
  artifactId: string,
  markdown: string,
  origin?: { readonly threadId: string; readonly runId: string }
): Promise<void> {
  const latest = await storage.artifacts.get({ projectId, id: artifactId })
  if (!latest) throw new Error(`Artifact '${artifactId}' was not stored.`)

  const body = new TextEncoder().encode(markdown)
  const file = await blobStorage.put({ body, expectedSizeBytes: body.byteLength })

  await storage.artifacts.publish({
    projectId,
    artifactId,
    kind: "document",
    version: {
      title: "Plan",
      entry: "document.md",
      files: [{ path: "document.md", file }],
      outline: { kind: "document", headings: [] },
      references: [],
      author: owner,
      ...(origin ? { origin } : {}),
      createdAt: new Date(),
    },
    baseVersion: latest.latestVersion,
  })
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

  test("points the Agent at a page's screenshots at both widths, and its warnings", () => {
    // Reproduce by wording every check as a deck's: the Agent looks for slide-NN.png.
    const output = {
      artifactId: "art_fl33tpl4n0",
      version: 2,
      kind: "page",
      title: "Fleet planner",
      warnings: [
        {
          code: "layout_wide",
          part: "phone",
          message: "On a phone (390px): table “Region” runs past the screen's right edge.",
        },
      ],
      layoutCheck: {
        screenshots: [
          ".sixb/agent/checks/art_fl33tpl4n0-v2/desktop.png",
          ".sixb/agent/checks/art_fl33tpl4n0-v2/phone.png",
        ],
      },
    }
    expect(tools().version.toModelOutput?.(output, context)).toEqual({
      type: "text",
      value: [
        'Published "Fleet planner" as artifact art_fl33tpl4n0, version 2.',
        "Warning (phone): On a phone (390px): table “Region” runs past the screen's right edge.",
        "Layout check: the page as the reader sees it, in light mode or the mode its theme.json pins, is .sixb/agent/checks/art_fl33tpl4n0-v2/desktop.png at 1280px and .sixb/agent/checks/art_fl33tpl4n0-v2/phone.png at 390px, each its top 4000px. Open them with view_file, fix what the warnings name, and publish the next version.",
      ].join("\n"),
    })
  })

  test("points the Agent at a canvas's board screenshots", () => {
    // Reproduce by wording a canvas's check as a deck's: the Agent looks for slide-NN.png.
    const output = {
      artifactId: "art_0nb0ard1ng",
      version: 1,
      kind: "canvas",
      title: "Field app onboarding",
      warnings: [],
      layoutCheck: {
        screenshots: [
          ".sixb/agent/checks/art_0nb0ard1ng-v1/boards/welcome.png",
          ".sixb/agent/checks/art_0nb0ard1ng-v1/boards/region.png",
        ],
      },
    }
    expect(tools().create.toModelOutput?.(output, context)).toMatchObject({
      value: expect.stringContaining(
        "Layout check: each board as the reader sees it, at its own size, in light mode or the mode its theme.json pins, is .sixb/agent/checks/art_0nb0ard1ng-v1/boards/<id>.png (2 boards)."
      ),
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

  // Guard proof: return `accessTo(artifact)` from `publishAccess` in core's artifacts/access.ts
  // whatever the thread; Bob's turn in his own thread then publishes Alice's report and shares it
  // there, so he keeps updating it once Alice removes him.
  test("refuses a participant's turn elsewhere the artifacts their conversation shares", async () => {
    const bob = { type: "user", id: "usr_bob" } as const
    write("work/review/document.md", "# Q3 review\n\nDraft.\n")
    const { artifactId } = (await publish({
      path: "work/review",
      kind: "document",
      title: "Q3 review",
    })) as { artifactId: string }
    await storage.agents.threads.addParticipants({
      projectId,
      threadId: run.threadId,
      principals: [bob],
      addedBy: owner,
      maxParticipants: 50,
    })
    const bobsThread = await startRun("thr_bob", bob)

    const elsewhere = await publishVersion(
      { id: artifactId, path: "work/review", title: "Bob's" },
      { author: bob, run: bobsThread }
    ).catch((error: unknown) => error)
    expect(tools().version.errorText(elsewhere)).toBe(
      `[SixbAgentWorker] publish_artifact_version refused: there is no artifact '${artifactId}'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact.`
    )
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifactId })).toEqual([
      run.threadId,
    ])

    // In the conversation that shares it, Bob's turn revises it.
    expect(
      await publishVersion({ id: artifactId, path: "work/review", title: "Bob's" }, { author: bob })
    ).toMatchObject({ version: 2 })

    // Removed, Bob reaches it no more: nothing else shares it with him.
    await storage.agents.threads.removeParticipant({
      projectId,
      threadId: run.threadId,
      principal: bob,
    })
    expect(await readerFor(bob).access(artifactId)).toBe("none")
    await expect(
      publishVersion(
        { id: artifactId, path: "work/review", title: "After" },
        { author: bob, run: bobsThread }
      )
    ).rejects.toBeInstanceOf(AgentToolPublicError)
    expect((await storage.artifacts.get({ projectId, id: artifactId }))?.latestVersion).toBe(2)
  })

  test("shares the owner's own artifact in the conversation their turn revises it in", async () => {
    const bob = { type: "user", id: "usr_bob" } as const
    await storage.agents.threads.addParticipants({
      projectId,
      threadId: run.threadId,
      principals: [bob],
      addedBy: owner,
      maxParticipants: 50,
    })
    const ownersThread = await startRun("thr_owner", owner)
    write("work/notes/document.md", "# Notes\n\nPrivate.\n")
    const { artifactId } = (await publish(
      { path: "work/notes", kind: "document", title: "Notes" },
      { run: ownersThread }
    )) as { artifactId: string }
    expect(await readerFor(bob).access(artifactId)).toBe("none")

    // Revising it in a conversation Bob takes part in shows it to him, with its history: that is
    // how a conversation starts sharing an artifact.
    await publishVersion({ id: artifactId, path: "work/notes", title: "Notes" })
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifactId })).toEqual([
      run.threadId,
      ownersThread.threadId,
    ])
    expect(await readerFor(bob).access(artifactId)).toBe("update")
  })

  // Guard proof: let `updatableArtifact` accept "read"; the observer's turn then reads the sandbox
  // before the transaction refuses it, and is told the path is missing instead.
  test("refuses an observer's turn before reading anything", async () => {
    const olivia: Principal = { type: "user", id: "usr_olivia" }
    write("work/review/document.md", "# Q3 review\n\nDraft.\n")
    const { artifactId } = (await publish({
      path: "work/review",
      kind: "document",
      title: "Q3 review",
    })) as { artifactId: string }

    const [, version] = createPublishArtifactTools({
      projectId,
      storage,
      artifacts: storage.artifacts,
      reader: readerFor(olivia, { "observe:agentThreads": true }),
      blobStorage,
      run,
      owner,
      author: olivia,
      budget: new AgentFileBudget(),
      installed: install({ requester: olivia }),
      resolveSandbox: async () => ({ sandbox: sandbox() }),
    })
    expect(await readerFor(olivia, { "observe:agentThreads": true }).access(artifactId)).toBe(
      "read"
    )

    const refused = await version
      .execute(version.parseInput({ id: artifactId, path: "missing", title: "Hers" }), context)
      .catch((error: unknown) => error)
    expect(version.errorText(refused)).toContain(`there is no artifact '${artifactId}'`)
  })

  test("says what to fix and stores nothing when the version is invalid", async () => {
    write("work/review/document.md", "# Q3 review\n\n![Chart](figures/missing.svg)\n")
    write("empty/.keep", "")
    mkdirSync(join(root, "blank"))

    expect(await refusal({ path: "work/review", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: document.md shows the image 'figures/missing.svg', which is not one of the artifact's files."
    )
    expect(await refusal({ path: "missing", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: there is no file or directory at 'missing'."
    )
    expect(await refusal({ path: "empty", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: 'empty' holds no files to publish."
    )
    expect(await refusal({ path: "blank", kind: "document", title: "Q3" })).toBe(
      "[SixbAgentWorker] publish_artifact refused: 'blank' is an empty directory."
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

  test("counts a file once per run, however many versions keep it", async () => {
    // The publish, look, fix loop the layout check asks for: each version keeps the figure.
    // Reproduce by reserving each version's whole size: the third version exceeds the budget.
    const figure = `<svg xmlns='http://www.w3.org/2000/svg'><desc>${"x".repeat(600)}</desc></svg>`
    write("work/review/figures/chart.svg", figure)
    write("work/review/document.md", "# Q3 review\n\n![Chart](figures/chart.svg)\n")
    const budget = new AgentFileBudget(1024)
    const installed = install()
    const first = (await publish(
      { path: "work/review", kind: "document", title: "Q3 review" },
      { budget, installed }
    )) as { artifactId: string }
    const firstBytes = budget.reservedBytes

    for (const draft of ["Second draft", "Third draft"]) {
      write("work/review/document.md", `# Q3 review\n\n${draft}.\n\n![Chart](figures/chart.svg)\n`)
      await publishVersion(
        { id: first.artifactId, path: "work/review", title: "Q3 review" },
        { budget, installed }
      )
    }
    expect(budget.reservedBytes).toBe(
      firstBytes +
        "# Q3 review\n\nSecond draft.\n\n![Chart](figures/chart.svg)\n".length +
        "# Q3 review\n\nThird draft.\n\n![Chart](figures/chart.svg)\n".length
    )
  })

  test("publishes nothing once the run no longer owns its execution", async () => {
    write("work/review/document.md", "# Q3 review\n\nRevenue grew.\n")

    const stale = await publish(
      { path: "work/review", kind: "document", title: "Q3 review" },
      { executionToken: "exec_stale" }
    ).catch((error: unknown) => error)
    expect(stale).toBeInstanceOf(AgentExecutionLostError)
    // The trace says why, not "An error occurred."
    expect(tools().create.errorText(stale)).toBe(
      "[SixbAgentWorker] publish_artifact refused: this run no longer holds its conversation, so nothing was published."
    )

    // The run ends while its files are read: the commit is fenced too. Reproduce by removing
    // `assertRunExecutionOwned` from the publish transaction; the ended run publishes.
    const [publisher] = createPublishArtifactTools({
      projectId,
      storage,
      artifacts: storage.artifacts,
      reader: readerFor(owner),
      blobStorage,
      run,
      owner,
      author: owner,
      budget: new AgentFileBudget(),
      installed: install(),
      resolveSandbox: async () => {
        await storage.agents.runs.finish({
          projectId,
          id: run.id,
          executionToken: run.executionToken,
          status: "failed",
        })
        return { sandbox: sandbox() }
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

  test("keeps the installed copy and the manifest at the version it just published", async () => {
    // Reproduce by not replacing the install after a publish: the copy and the manifest stay at
    // the version before, and revising from the copy publishes over this one.
    write("work/review/document.md", "# Q3 review\n\n![Chart](figures/chart.svg)\n")
    write("work/review/figures/chart.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
    const installed = install()
    const { artifactId } = (await publish(
      { path: "work/review", kind: "document", title: "Q3 review" },
      { installed }
    )) as { artifactId: string }
    const copy = `.sixb/agent/artifacts/${artifactId}`
    expect(read(`${copy}/document.md`)).toBe("# Q3 review\n\n![Chart](figures/chart.svg)\n")

    write("work/review/document.md", "# Q3 review\n\nNo chart.\n")
    rmSync(join(root, "work/review/figures"), { recursive: true })
    await publishVersion({ id: artifactId, path: "work/review", title: "Q3, final" }, { installed })

    expect(read(`${copy}/document.md`)).toBe("# Q3 review\n\nNo chart.\n")
    // The copy holds that version alone.
    expect(existsSync(join(root, copy, "figures"))).toBe(false)
    expect(JSON.parse(read(".sixb/agent/context/artifacts.json")).artifacts).toEqual([
      expect.objectContaining({
        id: artifactId,
        title: "Q3, final",
        version: 2,
        pinned: `artifact:${artifactId}@2`,
        directory: copy,
        files: ["document.md"],
      }),
    ])
    expect(JSON.parse((await installed).manifestJson)).toEqual(
      JSON.parse(read(".sixb/agent/context/artifacts.json"))
    )
  })

  test("refuses to publish over a version saved during the run, and installs that one", async () => {
    // Reproduce by publishing without the installed version as base: the Agent's version 3 lands
    // on version 2 and the person's edit is gone from the latest version. Reproduce the install by
    // skipping it on the refusal: the copy still holds version 1.
    write("work/plan/document.md", "# Plan\n\nDraft.\n")
    const { artifactId } = (await publish({
      path: "work/plan",
      kind: "document",
      title: "Plan",
    })) as {
      artifactId: string
    }
    const installed = install()
    await installed

    await publishElsewhere(artifactId, "# Plan\n\nThe person's edit.\n")

    write("work/plan/document.md", "# Plan\n\nThe Agent's edit.\n")
    const { version } = tools({ installed })
    const error = await version
      .execute(version.parseInput({ id: artifactId, path: "work/plan", title: "Plan" }), context)
      .catch((error: unknown) => error)

    expect(error).toBeInstanceOf(AgentToolPublicError)
    expect(version.errorText(error)).toBe(
      `[SixbAgentWorker] publish_artifact_version refused: artifact '${artifactId}' moved on from version 1, which you started from: version 2 was published by its owner outside a conversation, such as in the app, so nothing was published. $SIXB_ARTIFACTS lists version 2, installed under $SIXB_ARTIFACTS_DIR/${artifactId}/: start again from it as it is, keep its changes, make yours again, and publish.`
    )
    expect((await storage.artifacts.get({ projectId, id: artifactId }))?.latestVersion).toBe(2)

    // The copy and the manifest now hold the person's version, marked as edited.
    const copy = `.sixb/agent/artifacts/${artifactId}`
    expect(read(`${copy}/document.md`)).toBe("# Plan\n\nThe person's edit.\n")
    expect(JSON.parse(read(".sixb/agent/context/artifacts.json")).artifacts).toEqual([
      expect.objectContaining({ id: artifactId, version: 2, edited: true }),
    ])

    // Built on that version, the next publish goes through.
    write("work/plan/document.md", "# Plan\n\nThe person's edit, then the Agent's.\n")
    expect(
      await publishVersion({ id: artifactId, path: "work/plan", title: "Plan" }, { installed })
    ).toMatchObject({ artifactId, version: 3 })
  })

  test("lays a deck out with the files it publishes, and only those", async () => {
    write(
      "work/q3/index.html",
      '<!doctype html><html><head><title>Q3</title></head><body><section class="slide"><h2>Q3</h2><img src="img/fleet.svg" alt=""></section></body></html>'
    )
    write("work/q3/img/fleet.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>")
    write("work/q3/.notes", "a working note")

    // One file publishes alone, so its folder's images are not the reader's.
    const single = (await publish({ path: "work/q3/index.html", kind: "slides", title: "Q3" })) as {
      artifactId: string
    }
    const whole = (await publish({ path: "work/q3", kind: "slides", title: "Q3" })) as {
      artifactId: string
    }
    const served = (id: string) => JSON.parse(read(`.sixb/agent/checks/${id}-v1/files.json`))
    expect(served(single.artifactId)).toEqual(["index.html"])
    expect(served(whole.artifactId)).toEqual(["img/fleet.svg", "index.html"])
  })

  test("refuses input outside its schema", () => {
    const { create, version } = tools()
    expect(() => create.parseInput({ path: "a", kind: "map", title: "A" })).toThrow(
      "kind must be one of document, sheet, slides, page, canvas, file"
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
      "examples/sheet/overdue-invoices",
      "examples/page/fleet-planner",
      "examples/page/service-explorer",
      "examples/page/dispatch-board",
      "examples/canvas/onboarding-flow",
      "examples/canvas/retro",
    ])
    // slides.md says the decks use its layouts and classes alone; a legend's swatch is one.
    const decks = examples.filter(
      (file) => file.path.startsWith("examples/slides/") && file.path.endsWith(".html")
    )
    expect(decks).toHaveLength(2)
    for (const deck of decks) {
      expect(String(deck.contents)).not.toMatch(/<style|style="(?!--swatch:)/)
    }
    for (const directory of directories) {
      const kind = directory.split("/")[1] as "document" | "sheet" | "slides" | "page" | "canvas"
      // A live sheet's query is run as the requester, who reads the invoices and their amounts.
      expect(
        await publish(
          { path: directory, kind, title: directory },
          { grants: invoiceReader, clearances: new Set([financial.id]) }
        )
      ).toMatchObject({
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

    const installed = await install()

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
    const bounded = await install({ maxBytes: "# Second\n\nTwo.\n".length })
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
      threadId: "thr_other",
      artifacts: readerFor(owner),
      blobStorage,
      directory: ".sixb/agent/artifacts",
      manifestPath: ".sixb/agent/context/artifacts.json",
    })
    expect(JSON.parse(elsewhere.manifestJson)).toEqual({ artifacts: [] })
  })

  test("marks an artifact a person edited after the Agent published it", async () => {
    write("a/document.md", "# Plan\n\nDraft.\n")
    const { artifactId } = (await publish({ path: "a", kind: "document", title: "Plan" })) as {
      artifactId: string
    }
    expect(JSON.parse((await install()).manifestJson).artifacts[0]).not.toHaveProperty("edited")

    // The person saves version 2 in the app: no thread origin.
    const first = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
    if (!first) throw new Error("Version 1 was not stored.")
    const {
      projectId: _project,
      artifactId: _artifact,
      version: _version,
      origin: _origin,
      ...content
    } = first
    await storage.artifacts.publish({
      projectId,
      artifactId,
      kind: "document",
      version: { ...content, createdAt: new Date() },
      baseVersion: 1,
    })
    // Reproduce by marking every entry: the Agent's own versions read as edited too.
    expect(JSON.parse((await install()).manifestJson).artifacts[0]).toMatchObject({
      version: 2,
      edited: true,
    })
  })

  test("marks an artifact another conversation published after this one as edited too", async () => {
    // `edited` means "published outside this conversation", which is what the skill tells the
    // Agent. Reproduce by marking only versions without an origin: this one reads as unchanged.
    write("a/document.md", "# Plan\n\nDraft.\n")
    const { artifactId } = (await publish({ path: "a", kind: "document", title: "Plan" })) as {
      artifactId: string
    }

    await publishElsewhere(artifactId, "# Plan\n\nRevised elsewhere.\n", {
      threadId: "thr_other",
      runId: "run_other",
    })

    expect(JSON.parse((await install()).manifestJson).artifacts[0]).toMatchObject({
      version: 2,
      edited: true,
    })
  })

  test("lists a deck's slides with their addresses", async () => {
    write(
      "deck/index.html",
      '<!doctype html><html><head><title>Q3</title></head><body><section class="slide"><h1>Q3 review</h1></section><section class="slide"><p>No heading</p></section></body></html>'
    )
    const { artifactId } = (await publish({ path: "deck", kind: "slides", title: "Q3" })) as {
      artifactId: string
    }
    expect(JSON.parse((await install()).manifestJson).artifacts[0].parts).toEqual([
      {
        address: `artifact:${artifactId}#1`,
        pinned: `artifact:${artifactId}@1#1`,
        name: "Slide 1: Q3 review",
      },
      {
        address: `artifact:${artifactId}#2`,
        pinned: `artifact:${artifactId}@1#2`,
        name: "Slide 2",
      },
    ])
  })

  test("lists an artifact whose files cannot be read without them, and installs the rest", async () => {
    write("a/document.md", "# First\n\nOne.\n")
    write("b/document.md", "# Second\n\nTwo.\n")
    const first = (await publish({ path: "a", kind: "document", title: "First" })) as {
      artifactId: string
    }
    const second = (await publish({ path: "b", kind: "document", title: "Second" })) as {
      artifactId: string
    }
    const unreadable = (await storage.artifacts.getVersion({
      projectId,
      artifactId: first.artifactId,
      version: 1,
    }))!.files[0]!.file.blobId
    const open = blobStorage.open.bind(blobStorage)
    blobStorage.open = async (blobId) => {
      if (blobId === unreadable) throw new Error("the blob is gone")
      return open(blobId)
    }
    // One lost blob would otherwise fail every later run of the thread as its sandbox starts.
    // Reproduce by letting the read throw out of materializeThreadArtifacts.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const installed = await install()
      const entries = JSON.parse(installed.manifestJson).artifacts
      expect(entries.map((entry: { directory?: string }) => entry.directory)).toEqual([
        `.sixb/agent/artifacts/${second.artifactId}`,
        undefined,
      ])
      expect(installed.files.map((file) => file.path)).toEqual([
        `.sixb/agent/artifacts/${second.artifactId}/document.md`,
      ])
      expect(String(warn.mock.calls[0]?.[0])).toStartWith(
        `[SixbAgentWorker] Could not install version 1 of artifact '${first.artifactId}'`
      )
    } finally {
      warn.mockRestore()
    }
  })

  // Reproduce the first row by dropping readBlob's abort listener, and the second by dropping its
  // check for a cancel that came before that listener: either way the install waits on the blob.
  test.each([
    { when: "while the blob downloads", on: "pull" },
    { when: "after the blob opens, before the install listens", on: "getReader" },
  ] as const)("stops downloading when the run is cancelled $when", async ({ on }) => {
    write("a/document.md", "# First\n\nOne.\n")
    await publish({ path: "a", kind: "document", title: "First" })
    const cancel = new AbortController()
    const cancelRun = () => cancel.abort(new Error("cancelled"))
    blobStorage.open = async () => {
      // A blob that never finishes arriving, as a stalled download does. It is pulled once read.
      const stalled = new ReadableStream<Uint8Array>(
        {
          pull: () => {
            if (on === "pull") cancelRun()
            return new Promise(() => {})
          },
        },
        { highWaterMark: 0 }
      )
      if (on === "getReader") {
        const getReader = stalled.getReader.bind(stalled)
        Object.defineProperty(stalled, "getReader", {
          value: () => {
            cancelRun()
            return getReader()
          },
        })
      }
      return stalled
    }
    const installing = materializeThreadArtifacts({
      threadId: run.threadId,
      artifacts: readerFor(owner),
      blobStorage,
      directory: ".sixb/agent/artifacts",
      manifestPath: ".sixb/agent/context/artifacts.json",
      signal: cancel.signal,
    })
    let bound: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      installing.catch((error: unknown) => error),
      new Promise((resolve) => {
        bound = setTimeout(resolve, 1_000, "still downloading")
      }),
    ]).finally(() => clearTimeout(bound))
    expect(outcome).toEqual(new Error("cancelled"))
  })
})

describe("a version's queries", () => {
  /** Every invoice, without the amount the requester is not cleared to read. */
  const invoiceIds =
    '{"kind":"project","input":{"kind":"start","objectTypeId":"Invoice"},"properties":["id"]}'

  // Guard proof: drop `checkQuery: artifactQueryChecker(input.reader)` from the tool's publish; the
  // second version is then refused too, as a query nothing checks.
  test("are checked as the requester, who must be able to run each one", async () => {
    write("work/overdue/index.html", "<!doctype html><title>Overdue</title><p>Overdue</p>")
    write("work/overdue/queries/invoices.json", invoiceIds)
    const request = { path: "work/overdue", kind: "page", title: "Overdue" }

    const refused = await publish(request).catch((error: unknown) => error)
    expect(tools().create.errorText(refused)).toContain(
      "queries/invoices.json: Principal 'usr_owner' is not allowed to view object type 'Invoice'."
    )

    expect(
      await publish(request, { grants: { "view:object": new Set(["Invoice"]) } })
    ).toMatchObject({ version: 1 })
  })

  // Guard proof: drop the assertReturnsReadable call from createArtifactQueryChecker; the first
  // version then publishes with the amounts its requester is not cleared to read.
  test("return only what the requester can read", async () => {
    write("work/overdue/index.html", "<!doctype html><title>Overdue</title><p>Overdue</p>")
    write("work/overdue/queries/invoices.json", '{"kind":"start","objectTypeId":"Invoice"}')
    const request = { path: "work/overdue", kind: "page", title: "Overdue" }
    const grants = { "view:object": new Set(["Invoice"]) }

    const refused = await publish(request, { grants }).catch((error: unknown) => error)
    expect(tools().create.errorText(refused)).toContain(
      `queries/invoices.json: $: returns 'amount' on 'Invoice', which you are not cleared to read: add a "project" node that lists only the properties you can read.`
    )

    write("work/overdue/queries/invoices.json", invoiceIds)
    expect(await publish(request, { grants })).toMatchObject({ version: 1 })
  })

  // Guard proof: leave `queries/` out of listSources' files; the sheet is then refused, as its
  // query is not in the version.
  test("publish with the live sheet that reads one, which the manifest names", async () => {
    write(
      "work/overdue/workbook.json",
      JSON.stringify({
        sheets: [
          {
            name: "Overdue",
            query: "overdue",
            columns: { Invoice: { from: "number" }, Customer: { from: "customer.name" } },
          },
        ],
      })
    )
    write(
      "work/overdue/queries/overdue.json",
      JSON.stringify({
        kind: "expand",
        // Only what the requester can read: the invoices' amounts are marked.
        input: {
          kind: "project",
          input: { kind: "start", objectTypeId: "Invoice" },
          properties: ["number"],
        },
        expansions: [{ linkId: "customer", direction: "outgoing" }],
      })
    )

    const published = (await publish(
      { path: "work/overdue", kind: "sheet", title: "Overdue" },
      { grants: invoiceReader }
    )) as { artifactId: string }
    const version = await storage.artifacts.getVersion({
      projectId,
      artifactId: published.artifactId,
      version: 1,
    })
    expect(version?.files.map((file) => file.path).sort()).toEqual([
      "queries/overdue.json",
      "workbook.json",
    ])

    const [entry] = JSON.parse((await install()).manifestJson).artifacts
    expect(entry.parts[0].name).toBe(
      "Sheet Overdue: live rows of query overdue; columns Invoice, Customer"
    )
  })

  test("are run as the requester for the layout check, served as the API answers them", async () => {
    // The page reads the query route's JSON in the app, so the check serves that: rows with their
    // dates as ISO text. Reproduce by serving the rows as the reader returns them: each carries
    // what storage keeps beside it, its projectId and lastCommitId, which the route never sends.
    await createTestSixb(host).objects.upsert(Invoice.id, { id: "inv_1" })
    write("work/overdue/index.html", "<!doctype html><title>Overdue</title><p>Overdue</p>")
    write("work/overdue/queries/invoices.json", '{"kind":"start","objectTypeId":"Invoice"}')
    const grants = { "view:object": new Set(["Invoice"]) }

    // Cleared for the amounts the query returns, which publishing refuses otherwise.
    const published = (await publish(
      { path: "work/overdue", kind: "page", title: "Overdue" },
      { grants, clearances: new Set([financial.id]) }
    )) as { artifactId: string }

    const checks = `.sixb/agent/checks/${published.artifactId}-v1`
    expect(JSON.parse(read(`${checks}/queries.json`))).toEqual({ invoices: 200 })
    expect(JSON.parse(read(`${checks}/queries/invoices.json`))).toEqual({
      kind: "objects",
      objects: [
        {
          primaryId: "inv_1",
          objectTypeId: "Invoice",
          properties: { id: "inv_1" },
          createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
          updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        },
      ],
      total: 1,
      truncated: false,
      resultObjectTypeIds: ["Invoice"],
      readObjectTypeIds: ["Invoice"],
      // What a live view types its columns by, as the requester may view the ontology.
      schema: {
        properties: {
          id: { type: "string" },
          number: { type: "string" },
          status: { type: "string" },
          dueDate: { type: "date" },
          amount: { type: "double" },
          paid: { type: "double" },
        },
        links: {},
      },
    })
  })

  test("that fail for the requester are a warning, and the version stays published", async () => {
    // Publishing checked the query as the requester, but their rights can change before the
    // check runs it. Reproduce by letting the query's error out of checkedQueries: the publish
    // fails, though the version exists, and the Agent publishes it again.
    write("work/overdue/index.html", "<!doctype html><title>Overdue</title><p>Overdue</p>")
    write("work/overdue/queries/invoices.json", invoiceIds)
    const revoked = new AuthorizationError(
      "view:object:Invoice",
      "Principal 'usr_owner' is not allowed to view object type 'Invoice'."
    )

    const published = (await publish(
      { path: "work/overdue", kind: "page", title: "Overdue" },
      {
        grants: { "view:object": new Set(["Invoice"]) },
        reader: (reader) => {
          spyOn(reader, "query").mockRejectedValue(revoked)
        },
      }
    )) as { artifactId: string; version: number; warnings: unknown[] }

    expect(published.version).toBe(1)
    expect(published.warnings).toEqual([
      {
        code: "query_failed",
        message:
          "Query 'invoices' failed when the check ran it as you: Principal 'usr_owner' is not allowed to view object type 'Invoice'. The page was checked with sixb.query(\"invoices\") rejecting, as it does for every reader it fails for.",
      },
    ])

    const checks = `.sixb/agent/checks/${published.artifactId}-v1`
    expect(JSON.parse(read(`${checks}/queries.json`))).toEqual({ invoices: 409 })
    expect(JSON.parse(read(`${checks}/queries/invoices.json`))).toEqual({
      error: "Principal 'usr_owner' is not allowed to view object type 'Invoice'.",
    })
  })
})
