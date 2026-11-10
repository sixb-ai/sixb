import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
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
  artifactRef,
  type BlobStorage,
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
  ref,
  SixbHost,
} from "@sixb/core"
import { documentFiles } from "@sixb/core/artifacts/live"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import { AgentExecutionLostError, agentRunArtifacts } from "@sixb/core/internal/agents"
import {
  loadArtifactDocument,
  storeLiveFiles,
  writeLiveArtifact,
} from "@sixb/core/internal/artifacts/live"
import { emptyGrantIndex, type GrantIndex } from "@sixb/core/internal/authorization"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestAgentExecution, createTestSixb } from "@sixb/core/testing"
import * as Y from "yjs"
import {
  type InstalledArtifacts,
  installTurnArtifacts,
  materializeThreadArtifacts,
} from "../src/artifacts/materialize"
import { createPublishArtifactTools } from "../src/artifacts/publish-tool"
import { SANDBOX_CONTEXT_DIRECTORY } from "../src/run-sandbox"
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

/** A brief holds the document it was written from. */
const Brief = defineObjectType({
  id: "Brief",
  name: "Brief",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("doc", ref.artifact(), { nullable: true }),
  ],
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

/**
 * A turn's artifacts as its session reaches them: through the run's own SDK, bound to its
 * execution as the user who asked for it, with their rights now.
 */
function runArtifactsFor(
  options: {
    readonly user?: Principal
    readonly grants?: Partial<GrantIndex>
    readonly clearances?: ReadonlySet<string>
    readonly run?: typeof run
    readonly executionToken?: string
    readonly reader?: (reader: ReturnType<typeof readerFor>) => void
  } = {}
) {
  const user = options.user ?? owner
  if (user.type !== "user") throw new Error("A turn is asked for by a user.")
  const publishing = options.run ?? run
  const credential = { type: "session" as const, id: `session-${user.id}` }
  const sdk = bindDurableAgentExecution(host, {
    execution: {
      id: `exec_${publishing.id}`,
      projectId,
      requesterGroupIds: [],
      requestedBy: user,
      executor: { type: "agent", runId: publishing.id },
      source: { type: "execution", executionId: `request_${publishing.id}` },
      correlationId: `correlation_${publishing.id}`,
      authorizationRef: { type: "principal", principal: user, credential },
      createdAt: new Date(),
    },
    runId: publishing.id,
    authorization: {
      type: "principal",
      context: {
        principal: user,
        sessionId: credential.id,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true, ...options.grants },
        ...(options.clearances ? { clearances: options.clearances } : {}),
      },
    },
  })
  options.reader?.(sdk.artifacts)
  return agentRunArtifacts(
    { projectId, storage, domainEvents: host.events, broker: host.broker },
    { id: publishing.id, projectId, kind: "conversation", threadId: publishing.threadId },
    options.executionToken ?? publishing.executionToken,
    async () => sdk
  )
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
    ontology: [Customer, Invoice, Brief],
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
  /** What the sandbox's layout check reports; it has no browser when omitted. */
  readonly check?: Check
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
  /** The blob storage the tools store and read the Agent's files in; the project's when omitted. */
  readonly blobStorage?: BlobStorage
}

/** What a run installs in its sandbox before it publishes. */
function install(
  options: {
    readonly maxBytes?: number
    readonly requester?: Principal
    readonly grants?: Partial<GrantIndex>
  } = {}
): Promise<InstalledArtifacts> {
  const { requester, grants, ...rest } = options
  return materializeThreadArtifacts({
    threadId: run.threadId,
    artifacts: runArtifactsFor({ user: requester ?? owner, ...(grants ? { grants } : {}) }),
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
function sandbox(check: Check = skippedCheck): LocalBashSandbox {
  const local = new LocalBashSandbox(root)
  const run = local.runCommand.bind(local)
  local.runCommand = async (command, args, options) =>
    options?.env?.SIXB_CHECK_DECK === undefined
      ? run(command, args, options)
      : {
          exitCode: 0,
          stdout: `${JSON.stringify(check(options.env.SIXB_CHECK_OUT ?? ""))}\n`,
          stderr: "",
          durationMs: 0,
        }
  return local
}

/** What the check's script reports, given its output directory. */
type Check = (output: string) => Record<string, unknown>
const skippedCheck: Check = () => ({ skipped: "no_browser" })

/**
 * A canvas's check as the browser runs it: each board screenshot in light mode, and a board
 * `pictured` in dark mode too, each picture holding the board's id and mode.
 */
const canvasCheck: Check = (output) => {
  const boards = JSON.parse(readFileSync(join(output, "boards.json"), "utf8")) as {
    readonly id: string
    readonly pictured: boolean
  }[]
  const shot = (name: string, contents: string) => {
    mkdirSync(join(output, "boards"), { recursive: true })
    writeFileSync(join(output, "boards", name), contents)
    return join(output, "boards", name)
  }
  writeFileSync(join(output, "overview.png"), "the canvas")
  return {
    layout: "canvas",
    problems: [],
    errors: [],
    screenshots: boards.map((board) => shot(`${board.id}.png`, `${board.id} light`)),
    previews: boards
      .filter((board) => board.pictured)
      .flatMap((board) => [
        {
          board: board.id,
          theme: "light",
          size: "full",
          path: join(output, "boards", `${board.id}.png`),
        },
        {
          board: board.id,
          theme: "light",
          size: "small",
          path: shot(`${board.id}.light.small.webp`, `${board.id} light small`),
        },
        {
          board: board.id,
          theme: "dark",
          size: "full",
          path: shot(`${board.id}.dark.png`, `${board.id} dark`),
        },
        {
          board: board.id,
          theme: "dark",
          size: "small",
          path: shot(`${board.id}.dark.small.webp`, `${board.id} dark small`),
        },
      ]),
    overview: join(output, "overview.png"),
  }
}

function tools(options: ToolOptions = {}) {
  const [create, version, open] = createPublishArtifactTools({
    artifacts: runArtifactsFor({ ...options, user: options.author ?? owner }),
    threadId: (options.run ?? run).threadId,
    owner,
    blobStorage: options.blobStorage ?? blobStorage,
    budget: options.budget ?? new AgentFileBudget(),
    resolveSandbox: async () => ({
      sandbox: sandbox(options.check),
      contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
    }),
    installed: options.installed ?? install({ requester: options.author ?? owner }),
  })
  return { create, version, open }
}

/** `open_artifact`: installs one the conversation does not list. */
async function openArtifact(id: string, options?: ToolOptions): Promise<JsonValue> {
  const { open } = tools(options)
  return open.execute(open.parseInput({ id }), context)
}

/** `publish_artifact`: a new artifact. */
async function publish(input: Record<string, unknown>, options?: ToolOptions): Promise<JsonValue> {
  const { create } = tools(options)
  return create.execute(create.parseInput(input), context)
}

/** `update_artifact`: one's latest version. */
async function publishVersion(
  input: Record<string, unknown>,
  options?: ToolOptions
): Promise<JsonValue> {
  const { version } = tools(options)
  return version.execute(version.parseInput(input), context)
}

/** A Markdown file, stored. */
function documentFile(markdown: string) {
  const body = new TextEncoder().encode(markdown)
  return blobStorage.put({
    body,
    expectedSizeBytes: body.byteLength,
    fileName: "document.md",
    mediaType: "text/markdown",
  })
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
      updatedAt: new Date(),
    },
    baseRevision: latest.revision,
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

    expect(output).toMatchObject({
      version: 1,
      revision: 1,
      open: true,
      kind: "document",
      title: "Q3 review",
      warnings: [],
    })
    const id = (output as { artifactId: string }).artifactId
    const artifact = await storage.artifacts.get({ projectId, id })
    expect(artifact?.owner).toEqual(owner)
    const version = await storage.artifacts.getVersion({ projectId, artifactId: id, version: 1 })
    expect(version?.files.map((file) => file.path)).toEqual(["document.md", "figures/chart.svg"])
    expect(version?.origin).toEqual({ threadId: run.threadId, runId: run.id })
    expect(version?.author).toEqual(owner)
    expect(tools().create.toModelOutput?.(output, context)).toEqual({
      type: "text",
      value: `Published "Q3 review" as artifact ${id}, version 1 at revision 1.\nThe version is open: each update replaces it until the user creates a version. To change it, call update_artifact with this id.`,
    })
  })

  test("points the Agent at a page's screenshots at both widths, and its warnings", () => {
    // Reproduce by wording every check as a deck's: the Agent looks for slide-NN.png.
    const output = {
      artifactId: "art_fl33tpl4n0",
      version: 2,
      revision: 5,
      open: true,
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
          ".sixb/agent/checks/art_fl33tpl4n0-r5/desktop.png",
          ".sixb/agent/checks/art_fl33tpl4n0-r5/phone.png",
        ],
      },
    }
    expect(tools().version.toModelOutput?.(output, context)).toEqual({
      type: "text",
      value: [
        'Updated "Fleet planner": artifact art_fl33tpl4n0, version 2 at revision 5.',
        "The version is open: each update replaces it until the user creates a version. To change it, call update_artifact with this id.",
        "Warning (phone): On a phone (390px): table “Region” runs past the screen's right edge.",
        "Layout check: the page as the reader sees it, in light mode or the mode its theme.json pins, is .sixb/agent/checks/art_fl33tpl4n0-r5/desktop.png at 1280px and .sixb/agent/checks/art_fl33tpl4n0-r5/phone.png at 390px, each its top 4000px. Open them with read, fix what the warnings name, and update the artifact.",
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
          ".sixb/agent/checks/art_0nb0ard1ng-r1/boards/welcome.png",
          ".sixb/agent/checks/art_0nb0ard1ng-r1/boards/region.png",
        ],
      },
    }
    expect(tools().create.toModelOutput?.(output, context)).toMatchObject({
      value: expect.stringContaining(
        "Layout check: each board as the reader sees it, at its own size, in light mode or the mode its theme.json pins, is .sixb/agent/checks/art_0nb0ard1ng-r1/boards/<id>.png (2 boards)."
      ),
    })
  })

  test("tells the Agent of a board smaller than its page, with the size to give it", () => {
    // Reproduce by leaving the check's warnings out of the summary: the Agent reads only the
    // screenshots, each the page's top left, and never learns why.
    const output = {
      artifactId: "art_0nb0ard1ng",
      version: 1,
      kind: "canvas",
      title: "Pitch",
      warnings: [
        {
          code: "layout_board_too_small",
          part: "cover",
          message: "Board 'cover' is 520×292 but its page draws 1280×720.",
        },
      ],
      layoutCheck: { screenshots: [".sixb/agent/checks/art_0nb0ard1ng-v1/boards/cover.png"] },
    }
    expect(tools().create.toModelOutput?.(output, context)).toMatchObject({
      value: expect.stringContaining(
        "Warning (cover): Board 'cover' is 520×292 but its page draws 1280×720."
      ),
    })
  })

  test("keeps every picture it could read, and warns of a board one of whose was lost", async () => {
    // Reproduce by handing the pictures over all or nothing: the one picture the sandbox lost
    // leaves both boards without any, and the Agent is never told.
    const board = (id: string, x: number) => ({
      id,
      type: "board",
      file: `${id}.html`,
      x,
      y: 0,
      w: 390,
      h: 844,
    })
    write(
      "work/flow/canvas.json",
      JSON.stringify({ items: [board("welcome", 0), board("region", 480)] })
    )
    write("work/flow/welcome.html", "<main><h1>Welcome</h1></main>")
    write("work/flow/region.html", "<main><h1>Regions</h1></main>")
    // The check says it took Welcome's small dark picture, but it is not there to read.
    const lossy: Check = (output) => {
      const report = canvasCheck(output)
      rmSync(join(output, "boards", "welcome.dark.small.webp"))
      return report
    }

    const published = (await publish(
      { path: "work/flow", kind: "canvas", title: "Onboarding" },
      { check: lossy }
    )) as { artifactId: string; warnings: { code: string; part?: string; message: string }[] }

    const stored = await storage.artifacts.getVersion({
      projectId,
      artifactId: published.artifactId,
      version: 1,
    })
    const outline = stored?.outline
    const keys =
      outline?.kind === "canvas"
        ? outline.items.flatMap((item) => (item.type === "board" ? [item.renderKey ?? ""] : []))
        : []
    expect(await storage.artifacts.listBoardPreviews({ projectId, renderKeys: keys })).toHaveLength(
      7
    )
    expect(published.warnings.filter((warning) => warning.code === "preview_not_kept")).toEqual([
      {
        code: "preview_not_kept",
        part: "welcome",
        message:
          "Board 'welcome' has no preview for the small one in dark mode (it could not be read): readers see its outline there until they open it.",
      },
    ])
  })

  test("keeps the pictures of a canvas's boards, and pictures only the boards it changed", async () => {
    // Reproduce the second half by picturing every board: the welcome board, kept as it was, is
    // pictured again. Reproduce the first by dropping storePreviews: nothing is kept.
    const board = (id: string, x: number) => ({
      id,
      type: "board",
      file: `${id}.html`,
      x,
      y: 0,
      w: 390,
      h: 844,
    })
    write(
      "work/flow/canvas.json",
      JSON.stringify({ items: [board("welcome", 0), board("region", 480)] })
    )
    write("work/flow/welcome.html", "<main><h1>Welcome</h1></main>")
    write("work/flow/region.html", "<main><h1>Regions</h1></main>")
    const pictures = async (artifactId: string, version: number) => {
      const stored = await storage.artifacts.getVersion({ projectId, artifactId, version })
      const outline = stored?.outline
      const keys =
        outline?.kind === "canvas"
          ? outline.items.flatMap((item) => (item.type === "board" ? [item.renderKey ?? ""] : []))
          : []
      const kept = await storage.artifacts.listBoardPreviews({ projectId, renderKeys: keys })
      return Promise.all(
        kept.map(
          async ({ theme, file }) =>
            `${theme}: ${await new Response(await blobStorage.open(file.blobId)).text()}`
        )
      )
    }

    const first = (await publish(
      { path: "work/flow", kind: "canvas", title: "Onboarding" },
      { check: canvasCheck }
    )) as { artifactId: string; layoutCheck: { overview: string } }
    expect((await pictures(first.artifactId, 1)).sort()).toEqual([
      "dark: region dark",
      "dark: region dark small",
      "dark: welcome dark",
      "dark: welcome dark small",
      "light: region light",
      "light: region light small",
      "light: welcome light",
      "light: welcome light small",
    ])
    expect(first.layoutCheck.overview).toBe(
      `.sixb/agent/checks/${first.artifactId}-r1/overview.png`
    )
    expect(tools().create.toModelOutput?.(first as unknown as JsonValue, context)).toMatchObject({
      value: expect.stringContaining(
        `Open .sixb/agent/checks/${first.artifactId}-r1/overview.png to see the canvas as it opens`
      ),
    })

    write("work/flow/region.html", "<main><h1>Regions, by city</h1></main>")
    await publishVersion(
      { id: first.artifactId, path: "work/flow", title: "Onboarding" },
      { check: canvasCheck }
    )

    // The update replaced the open version: its check is the new revision's.
    const checked = JSON.parse(read(`.sixb/agent/checks/${first.artifactId}-r2/boards.json`)) as {
      readonly id: string
      readonly pictured: boolean
    }[]
    expect(checked.map(({ id, pictured }) => `${id}: ${pictured}`)).toEqual([
      "welcome: false",
      "region: true",
    ])
    expect((await pictures(first.artifactId, 1)).sort()).toEqual([
      "dark: region dark",
      "dark: region dark small",
      "dark: welcome dark",
      "dark: welcome dark small",
      "light: region light",
      "light: region light small",
      "light: welcome light",
      "light: welcome light small",
    ])
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

  test("updates an artifact the owner has, in its kind, in its open version", async () => {
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
    ).toMatchObject({
      artifactId: review.artifactId,
      version: 1,
      revision: 2,
      open: true,
      kind: "document",
      title: "Final",
    })
    // A file keeps its kind, so a single file publishes under its own name, not as a document.
    await publishVersion({ id: regions.artifactId, path: "exports/regions.csv", title: "Regions" })
    const regionsUpdated = await storage.artifacts.getVersion({
      projectId,
      artifactId: regions.artifactId,
      version: 1,
    })
    expect(regionsUpdated?.files.map((file) => file.path)).toEqual(["regions.csv"])
    expect(regionsUpdated?.revision).toBe(2)

    // Once the user creates the version, the next update opens the next one.
    await storage.artifacts.freeze({
      projectId,
      artifactId: review.artifactId,
      frozenAt: new Date(),
      frozenBy: owner,
    })
    write("work/review/document.md", "# Q3 review\n\nAfter the review.\n")
    const opened = await publishVersion(
      { id: review.artifactId, path: "work/review", title: "Final" },
      { installed: install() }
    )
    expect(opened).toMatchObject({ version: 2, revision: 4, open: true })
    expect(tools().version.toModelOutput?.(opened, context)).toMatchObject({
      value: expect.stringContaining(
        `Updated "Final": artifact ${review.artifactId}, version 2 at revision 4.\nThe version is open:`
      ),
    })
  })

  test("refuses ids that are not an artifact of the owner's, and says how to create one", async () => {
    write("work/review/document.md", "# Q3 review\n\nDraft.\n")
    const shape =
      "[SixbAgent] update_artifact refused: id must be an artifact id such as art_k3m9q2x7tp. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact."
    // What a model sends when it means "no artifact yet".
    for (const id of [" ", "", "new", "null", "0", ".sixb-new"]) {
      expect(await refusal({ id, path: "work/review", title: "Q3" }, "version")).toBe(shape)
    }
    expect(
      await refusal({ id: "art_0000000000", path: "work/review", title: "Q3" }, "version")
    ).toBe(
      "[SixbAgent] update_artifact refused: there is no artifact 'art_0000000000'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact."
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
      `[SixbAgent] update_artifact refused: there is no artifact '${artifactId}'. $SIXB_ARTIFACTS lists this conversation's artifacts; to create a new one, call publish_artifact.`
    )
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifactId })).toEqual([
      run.threadId,
    ])

    // In the conversation that shares it, Bob's turn revises it.
    expect(
      await publishVersion({ id: artifactId, path: "work/review", title: "Bob's" }, { author: bob })
    ).toMatchObject({ version: 1, revision: 2 })

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
    expect((await storage.artifacts.get({ projectId, id: artifactId }))?.revision).toBe(2)
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
    // how a conversation starts sharing an artifact. The turn opens it first, never writing blind.
    const installed = install()
    const blind = await publishVersion(
      { id: artifactId, path: "work/notes", title: "Notes" },
      { installed }
    ).catch((error: unknown) => tools().version.errorText(error))
    expect(blind).toBe(
      `[SixbAgent] update_artifact refused: artifact '${artifactId}' is not open in this conversation, so nothing was published: call open_artifact with its id, then revise its copy and update it.`
    )

    expect(await openArtifact(artifactId, { installed })).toMatchObject({
      artifactId,
      revision: 1,
      readOnly: false,
    })
    expect(read(`.sixb/agent/artifacts/${artifactId}/document.md`)).toBe("# Notes\n\nPrivate.\n")
    expect(await readerFor(bob).access(artifactId)).toBe("none")

    await publishVersion({ id: artifactId, path: "work/notes", title: "Notes" }, { installed })
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifactId })).toEqual([
      run.threadId,
      ownersThread.threadId,
    ])
    expect(await readerFor(bob).access(artifactId)).toBe("update")
  })

  // Guard proof: drop the refusal of an artifact the manifest does not list from publish(); the
  // turn then writes over Carol's brief without having read it.
  test("revises an artifact an object its requester edits holds, from what it holds", async () => {
    const carol = { type: "user", id: "usr_carol" } as const
    const editor = { "view:object": new Set([Brief.id]), "edit:object": new Set([Brief.id]) }
    const { artifact } = await readerFor(carol).create({
      kind: "document",
      title: "Brief",
      files: [{ path: "document.md", file: await documentFile("# Brief\n\nCarol's.\n") }],
    })
    await createTestSixb(host)
      .objects(Brief)
      .upsert({ properties: { id: "b1", doc: artifactRef(artifact.id) } })

    const installed = install()
    write("work/brief/document.md", "# Brief\n\nWritten blind.\n")
    const blind = await publishVersion(
      { id: artifact.id, path: "work/brief", title: "Brief" },
      { installed, grants: editor }
    ).catch((error: unknown) => tools().version.errorText(error))
    expect(blind).toContain("is not open in this conversation")
    expect((await storage.artifacts.get({ projectId, id: artifact.id }))?.revision).toBe(1)

    expect(await openArtifact(artifact.id, { installed, grants: editor })).toMatchObject({
      title: "Brief",
      readOnly: false,
      directory: `.sixb/agent/artifacts/${artifact.id}`,
    })
    const copy = `.sixb/agent/artifacts/${artifact.id}/document.md`
    write(copy, "# Brief\n\nCarol's, revised.\n")
    expect(
      await publishVersion(
        { id: artifact.id, path: `.sixb/agent/artifacts/${artifact.id}`, title: "Brief" },
        { installed, grants: editor }
      )
    ).toMatchObject({ artifactId: artifact.id, revision: 2 })
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifact.id })).toEqual([
      run.threadId,
    ])
  })

  // Guard proof: install every opened artifact as changeable in `open` (publish-tool.ts); the
  // manifest then offers Carol's brief for revision, and the update is refused as if it were gone.
  test("opens to read an artifact an object its requester reads holds, and changes nothing", async () => {
    const carol = { type: "user", id: "usr_carol" } as const
    const reader = { "view:object": new Set([Brief.id]) }
    const { artifact } = await readerFor(carol).create({
      kind: "document",
      title: "Brief",
      files: [{ path: "document.md", file: await documentFile("# Brief\n\nCarol's.\n") }],
    })
    await createTestSixb(host)
      .objects(Brief)
      .upsert({ properties: { id: "b1", doc: artifactRef(artifact.id) } })

    const installed = install()
    const opened = await openArtifact(artifact.id, { installed, grants: reader })
    expect(opened).toMatchObject({ artifactId: artifact.id, title: "Brief", readOnly: true })
    expect(await tools().open.toModelOutput?.(opened, context)).toEqual({
      type: "text",
      value: `Opened "Brief": artifact ${artifact.id}, version 1 at revision 1, installed under .sixb/agent/artifacts/${artifact.id}/. The user may read it but not change it: do not update it.`,
    })
    expect(read(`.sixb/agent/artifacts/${artifact.id}/document.md`)).toBe("# Brief\n\nCarol's.\n")
    expect(JSON.parse(read(".sixb/agent/context/artifacts.json")).artifacts).toEqual([
      expect.objectContaining({ id: artifact.id, revision: 1, edited: true, readOnly: true }),
    ])

    // Updating it from there is refused as a reader's change, and nothing shares it.
    const refused = await publishVersion(
      { id: artifact.id, path: `.sixb/agent/artifacts/${artifact.id}`, title: "Brief" },
      { installed, grants: reader }
    ).catch((error: unknown) => tools().version.errorText(error))
    expect(refused).toBe(
      `[SixbAgent] update_artifact refused: you can read artifact '${artifact.id}' but not change it, so nothing was published.`
    )
    expect(await storage.artifacts.listThreadIds({ projectId, id: artifact.id })).toEqual([])

    // One the requester cannot read, or that does not exist, opens nothing.
    const unread = await openArtifact(artifact.id).catch((error: unknown) =>
      tools().open.errorText(error)
    )
    expect(unread).toBe(
      `[SixbAgent] open_artifact refused: there is no artifact '${artifact.id}' you can read.`
    )
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

    const observes = { "observe:agentThreads": true }
    const [, version] = createPublishArtifactTools({
      artifacts: runArtifactsFor({ user: olivia, grants: observes }),
      threadId: run.threadId,
      owner,
      blobStorage,
      budget: new AgentFileBudget(),
      installed: install({ requester: olivia, grants: observes }),
      resolveSandbox: async () => ({
        sandbox: sandbox(),
        contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
      }),
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
      "[SixbAgent] publish_artifact refused: document.md shows the image 'figures/missing.svg', which is not one of the artifact's files."
    )
    expect(await refusal({ path: "missing", kind: "document", title: "Q3" })).toBe(
      "[SixbAgent] publish_artifact refused: there is no file or directory at 'missing'."
    )
    expect(await refusal({ path: "empty", kind: "document", title: "Q3" })).toBe(
      "[SixbAgent] publish_artifact refused: 'empty' holds no files to publish."
    )
    expect(await refusal({ path: "blank", kind: "document", title: "Q3" })).toBe(
      "[SixbAgent] publish_artifact refused: 'blank' is an empty directory."
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

  test("counts a file once per run, however many updates keep it", async () => {
    // The publish, look, fix loop the layout check asks for: each update keeps the figure.
    // Reproduce by reserving each update's whole size: the third one exceeds the budget.
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
      "[SixbAgent] publish_artifact refused: this run no longer holds its conversation, so nothing was published."
    )
    expect((await storage.artifacts.list({ projectId })).artifacts).toEqual([])
  })

  test("keeps the installed copy and the manifest at the revision it just wrote", async () => {
    // Reproduce by not replacing the install after a publish: the copy and the manifest stay at
    // the revision before, and revising from the copy is refused as moved.
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
    // The copy holds that revision alone. Open, the version has no pinned address.
    expect(existsSync(join(root, copy, "figures"))).toBe(false)
    const [entry] = JSON.parse(read(".sixb/agent/context/artifacts.json")).artifacts
    expect(entry).toEqual(
      expect.objectContaining({
        id: artifactId,
        title: "Q3, final",
        version: 1,
        revision: 2,
        open: true,
        address: `artifact:${artifactId}`,
        directory: copy,
        files: ["document.md"],
      })
    )
    expect(entry).not.toHaveProperty("pinned")
    expect(JSON.parse((await installed).manifestJson)).toEqual(
      JSON.parse(read(".sixb/agent/context/artifacts.json"))
    )
  })

  // Reproduce by leaving `baseFiles` out of the update in publish(): the person's note, saved in
  // the app meanwhile, refuses the update; drop `mergedFiles`, and the copy lacks their note.
  test("merges an update to a canvas with a save made during the run, and says so", async () => {
    const items = (note?: string) =>
      JSON.stringify({
        items: [
          { id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 },
          ...(note ? [{ id: "todo", type: "note", x: 0, y: 900, w: 200, text: note }] : []),
        ],
      })
    write("work/flow/canvas.json", items())
    write("work/flow/welcome.html", "<main><h1>Welcome</h1></main>")
    const { artifactId } = (await publish({
      path: "work/flow",
      kind: "canvas",
      title: "Flow",
    })) as {
      artifactId: string
    }
    const installed = install()
    await installed

    // The person adds a note in the app.
    const latest = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
    if (!latest) throw new Error("Expected version 1.")
    const body = new TextEncoder().encode(items("Ship it"))
    const canvas = await blobStorage.put({ body, expectedSizeBytes: body.byteLength })
    await storage.artifacts.publish({
      projectId,
      artifactId,
      kind: "canvas",
      version: {
        ...latest,
        files: latest.files.map((entry) =>
          entry.path === "canvas.json" ? { ...entry, file: canvas } : entry
        ),
        updatedAt: new Date(),
      },
      baseRevision: 1,
    })

    // The Agent, from its copy at revision 1, rewrites the board.
    write("work/flow/welcome.html", "<main><h1>Hello</h1></main>")
    const output = (await publishVersion(
      { id: artifactId, path: "work/flow", title: "Flow" },
      { installed }
    )) as { revision: number; mergedSince?: number }

    expect(output).toMatchObject({ revision: 3, mergedSince: 1 })
    expect(tools().version.toModelOutput?.(output as unknown as JsonValue, context)).toMatchObject({
      value: expect.stringContaining(
        "Merged with changes made meanwhile, since revision 1, which you started from: your folder now holds the merged result"
      ),
    })
    const copy = `.sixb/agent/artifacts/${artifactId}`
    expect(
      JSON.parse(read(`${copy}/canvas.json`)).items.map((item: { id: string }) => item.id)
    ).toEqual(["welcome", "todo"])
    expect(read(`${copy}/welcome.html`)).toBe("<main><h1>Hello</h1></main>")
  })

  // Reproduce by dropping `syncPublishedFolder` from publish(): the Agent's folder keeps what it
  // wrote, without the words merged in, and its next update, made from that folder, takes them
  // out.
  test("keeps every word a person types in a board live while the Agent's turn updates it", async () => {
    const board = (heading: string) => `<main>\n  <p>Notes:</p>\n  <h1>${heading}</h1>\n</main>\n`
    write(
      "work/flow/canvas.json",
      JSON.stringify({
        items: [{ id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 }],
      })
    )
    write("work/flow/welcome.html", board("Welcome"))
    const { artifactId } = (await publish({
      path: "work/flow",
      kind: "canvas",
      title: "Flow",
    })) as {
      artifactId: string
    }
    const installed = install()
    await installed

    // The person's live document, as a room holds it, typing in the paragraph and writing back.
    const latest = async () => {
      const artifact = await storage.artifacts.get({ projectId, id: artifactId })
      const version =
        artifact &&
        (await storage.artifacts.getVersion({
          projectId,
          artifactId,
          version: artifact.latestVersion,
        }))
      if (!artifact || !version) throw new Error("Expected the canvas.")
      return { artifact, version }
    }
    const stored = async () => {
      const { artifact, version } = await latest()
      return loadArtifactDocument(blobStorage, artifact, version.files)
    }
    const doc = await stored()
    const text = () => doc.getMap("files").get("welcome.html") as Y.Text
    const type = (word: string) => text().insert(text().toString().indexOf("</p>"), ` ${word}`)
    const follow = async () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(await stored()))
    const writeBack = async () => {
      const { artifact, version } = await latest()
      await writeLiveArtifact(readerFor(owner), artifactId, {
        title: artifact.title,
        baseTitle: artifact.title,
        files: await storeLiveFiles(blobStorage, documentFiles(doc), version.files),
        baseRevision: artifact.revision,
        update: Y.encodeStateAsUpdate(doc),
      })
      await follow()
    }

    type("w1")
    await writeBack()

    // The Agent, from its copy, retitles the board: merged, its copy is installed again.
    write("work/flow/welcome.html", board("Hello"))
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    await follow()

    // It edits its folder again, which holds the merged result, while the person types: nobody
    // wrote since its last update, which merged their first word in.
    const edit = (heading: string) =>
      write(
        "work/flow/welcome.html",
        read("work/flow/welcome.html").replace(/<h1>.*<\/h1>/, `<h1>${heading}</h1>`)
      )
    expect(read("work/flow/welcome.html")).toContain("Notes: w1</p>")
    type("w2")
    edit("Hello again")
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    await follow()
    type("w3")
    type("w4")
    await writeBack()
    type("w5")

    // And once more, now that the person wrote since.
    edit("Hello, team")
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    await follow()
    type("w6")
    await writeBack()

    const { version } = await latest()
    const welcome = version.files.find((entry) => entry.path === "welcome.html")
    const html = welcome
      ? await new Response(await blobStorage.open(welcome.file.blobId)).text()
      : ""
    expect(html).toBe(
      "<main>\n  <p>Notes: w1 w2 w3 w4 w5 w6</p>\n  <h1>Hello, team</h1>\n</main>\n"
    )
    expect(text().toString()).toBe(html)
  })

  // Reproduce by installing the Agent's own files when the merged ones cannot be read, as before:
  // the base moves to the merged revision while the folder lacks the person's word, and the next
  // update, from the folder, takes it out.
  test("keeps a person's words when the merged result cannot be read back into the Agent's folder", async () => {
    const board = (heading: string) => `<main>\n  <p>Notes:</p>\n  <h1>${heading}</h1>\n</main>\n`
    write(
      "work/flow/canvas.json",
      JSON.stringify({
        items: [{ id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 }],
      })
    )
    write("work/flow/welcome.html", board("Welcome"))
    const { artifactId } = (await publish({
      path: "work/flow",
      kind: "canvas",
      title: "Flow",
    })) as {
      artifactId: string
    }
    const installed = install()
    await installed

    // The person types a word in the board, live.
    const { artifact, version } = await (async () => {
      const stored = await storage.artifacts.get({ projectId, id: artifactId })
      const latest =
        stored &&
        (await storage.artifacts.getVersion({
          projectId,
          artifactId,
          version: stored.latestVersion,
        }))
      if (!stored || !latest) throw new Error("Expected the canvas.")
      return { artifact: stored, version: latest }
    })()
    const doc = await loadArtifactDocument(blobStorage, artifact, version.files)
    const text = doc.getMap("files").get("welcome.html") as Y.Text
    text.insert(text.toString().indexOf("</p>"), " w1")
    await writeLiveArtifact(readerFor(owner), artifactId, {
      title: artifact.title,
      baseTitle: artifact.title,
      files: await storeLiveFiles(blobStorage, documentFiles(doc), version.files),
      baseRevision: artifact.revision,
      update: Y.encodeStateAsUpdate(doc),
    })

    // The Agent retitles the board: merged and stored, but the blob store fails as the tool reads
    // the merged files back.
    const unreadable = new Proxy(blobStorage, {
      get(target, key) {
        if (key === "open") {
          return async () => {
            throw new Error("The blob store is unavailable.")
          }
        }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    write("work/flow/welcome.html", board("Hello"))
    const output = await publishVersion(
      { id: artifactId, path: "work/flow", title: "Flow" },
      { installed, blobStorage: unreadable }
    )

    expect(output).toMatchObject({ mergedSince: 1, notInstalled: true, nextUpdateFrom: 1 })
    expect(tools().version.toModelOutput?.(output, context)).toMatchObject({
      value: expect.stringContaining(
        "the merged result could not be installed: your folder and $SIXB_ARTIFACTS_DIR/"
      ),
    })
    expect(read("work/flow/welcome.html")).toBe(board("Hello"))

    // From its folder, which lacks the word, it retitles the board again.
    write("work/flow/welcome.html", board("Hello again"))
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })

    const { version: latest } = await (async () => {
      const stored = await storage.artifacts.get({ projectId, id: artifactId })
      const at =
        stored &&
        (await storage.artifacts.getVersion({
          projectId,
          artifactId,
          version: stored.latestVersion,
        }))
      if (!at) throw new Error("Expected the canvas.")
      return { version: at }
    })()
    const welcome = latest.files.find((entry) => entry.path === "welcome.html")
    expect(
      welcome ? await new Response(await blobStorage.open(welcome.file.blobId)).text() : ""
    ).toBe("<main>\n  <p>Notes: w1</p>\n  <h1>Hello again</h1>\n</main>\n")
  })

  // Reproduce by recording the files the Agent submitted as the base of its next update, instead
  // of the stored result: the word its copy holds, and the person typed, is in the board twice.
  test("keeps each of their words once when the Agent updates from its installed copy", async () => {
    const board = (heading: string) => `<main>\n  <p>Notes:</p>\n  <h1>${heading}</h1>\n</main>\n`
    write(
      "work/flow/canvas.json",
      JSON.stringify({
        items: [{ id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 }],
      })
    )
    write("work/flow/welcome.html", board("Welcome"))
    const { artifactId } = (await publish({
      path: "work/flow",
      kind: "canvas",
      title: "Flow",
    })) as {
      artifactId: string
    }
    const installed = install()
    await installed

    // The person's live document, as a room holds it, typing in the paragraph and writing back.
    const latest = async () => {
      const artifact = await storage.artifacts.get({ projectId, id: artifactId })
      const version =
        artifact &&
        (await storage.artifacts.getVersion({
          projectId,
          artifactId,
          version: artifact.latestVersion,
        }))
      if (!artifact || !version) throw new Error("Expected the canvas.")
      return { artifact, version }
    }
    const stored = async () => {
      const { artifact, version } = await latest()
      return loadArtifactDocument(blobStorage, artifact, version.files)
    }
    const doc = await stored()
    const text = () => doc.getMap("files").get("welcome.html") as Y.Text
    const type = (word: string) => text().insert(text().toString().indexOf("</p>"), ` ${word}`)
    const follow = async () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(await stored()))
    const writeBack = async () => {
      const { artifact, version } = await latest()
      await writeLiveArtifact(readerFor(owner), artifactId, {
        title: artifact.title,
        baseTitle: artifact.title,
        files: await storeLiveFiles(blobStorage, documentFiles(doc), version.files),
        baseRevision: artifact.revision,
        update: Y.encodeStateAsUpdate(doc),
      })
      await follow()
    }

    type("w1")
    await writeBack()

    // The Agent, from its copy, retitles the board: merged, its copy is installed again.
    write("work/flow/welcome.html", board("Hello"))
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    await follow()

    // It starts from its copy, as it is told to, which holds the person's first word; they type on.
    const copy = `.sixb/agent/artifacts/${artifactId}/welcome.html`
    write("work/flow/welcome.html", read(copy).replace("Hello", "Hello, team"))
    type("w2")
    type("w3")
    await writeBack()
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    await follow()

    const { version } = await latest()
    const welcome = version.files.find((entry) => entry.path === "welcome.html")
    const html = welcome
      ? await new Response(await blobStorage.open(welcome.file.blobId)).text()
      : ""
    expect(html).toBe("<main>\n  <p>Notes: w1 w2 w3</p>\n  <h1>Hello, team</h1>\n</main>\n")
    expect(text().toString()).toBe(html)
  })

  // Reproduce by not writing the revision into the folder the Agent published from in
  // InstalledArtifacts.replace: the folder lacks the child's note, and the parent's update from
  // it takes the note out.
  test("writes a child's write into the folder the parent published from, so the parent keeps it", async () => {
    const items = (note?: string) =>
      JSON.stringify({
        items: [
          { id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 },
          ...(note ? [{ id: "todo", type: "note", x: 0, y: 900, w: 200, text: note }] : []),
        ],
      })
    write("work/flow/canvas.json", items())
    write("work/flow/welcome.html", "<main><h1>Welcome</h1></main>")
    const installed = install()
    const { artifactId } = (await publish(
      { path: "work/flow", kind: "canvas", title: "Flow" },
      { installed }
    )) as { artifactId: string }

    // A child of the turn adds a note to the canvas.
    const latest = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
    if (!latest) throw new Error("Expected version 1.")
    const body = new TextEncoder().encode(items("Ship it"))
    const canvas = await blobStorage.put({ body, expectedSizeBytes: body.byteLength })
    await runArtifactsFor().publish({
      artifactId,
      title: "Flow",
      files: latest.files.map((entry) =>
        entry.path === "canvas.json" ? { ...entry, file: canvas } : entry
      ),
      baseRevision: latest.revision,
      baseFiles: latest.files,
    })

    // Waiting for it, the parent installs what it wrote: in its copy, and in its folder.
    const folders = await installTurnArtifacts({
      installed: await installed,
      artifacts: runArtifactsFor(),
      blobStorage,
      sandbox: sandbox(),
      signal: new AbortController().signal,
    })
    expect(folders).toEqual(["work/flow"])
    expect(read("work/flow/canvas.json")).toContain("Ship it")

    // It updates from its folder: the child's note stays.
    write("work/flow/welcome.html", "<main><h1>Hello</h1></main>")
    await publishVersion({ id: artifactId, path: "work/flow", title: "Flow" }, { installed })
    const artifact = await storage.artifacts.get({ projectId, id: artifactId })
    const version =
      artifact &&
      (await storage.artifacts.getVersion({
        projectId,
        artifactId,
        version: artifact.latestVersion,
      }))
    const stored = version?.files.find((entry) => entry.path === "canvas.json")
    const json = stored ? await new Response(await blobStorage.open(stored.file.blobId)).text() : ""
    expect(JSON.parse(json).items.map((item: { id: string }) => item.id)).toEqual([
      "welcome",
      "todo",
    ])
  })

  test("refuses to update over a save made during the run, and installs it", async () => {
    // Reproduce by publishing without the installed revision as base: the Agent's update replaces
    // the person's save unseen. Reproduce the install by skipping it on the refusal: the copy
    // still holds revision 1.
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
      `[SixbAgent] update_artifact refused: artifact '${artifactId}' changed since revision 1, which you started from: it is at revision 2, whose version 1 was last written by its owner outside a conversation, such as in the app, so nothing was published. $SIXB_ARTIFACTS lists revision 2, installed under $SIXB_ARTIFACTS_DIR/${artifactId}/: start again from it as it is, keep its changes, make yours again, and update it.`
    )
    expect((await storage.artifacts.get({ projectId, id: artifactId }))?.revision).toBe(2)

    // The copy and the manifest now hold the person's version, marked as edited.
    const copy = `.sixb/agent/artifacts/${artifactId}`
    expect(read(`${copy}/document.md`)).toBe("# Plan\n\nThe person's edit.\n")
    expect(JSON.parse(read(".sixb/agent/context/artifacts.json")).artifacts).toEqual([
      expect.objectContaining({ id: artifactId, version: 1, revision: 2, edited: true }),
    ])

    // Built on that revision, the next update goes through.
    write("work/plan/document.md", "# Plan\n\nThe person's edit, then the Agent's.\n")
    expect(
      await publishVersion({ id: artifactId, path: "work/plan", title: "Plan" }, { installed })
    ).toMatchObject({ artifactId, version: 1, revision: 3 })

    // A version created during the run is named with who created it.
    const bob = { type: "user", id: "usr_bob" } as const
    await storage.artifacts.freeze({ projectId, artifactId, frozenAt: new Date(), frozenBy: bob })
    const stale = await version
      .execute(version.parseInput({ id: artifactId, path: "work/plan", title: "Plan" }), context)
      .catch((error: unknown) => error)
    expect(version.errorText(stale)).toContain(
      "whose version 1 was last written earlier in this conversation, and then created as a version by user 'usr_bob', so nothing was published"
    )

    // Published from work/plan since, that folder takes what a refusal installs, as the copy does.
    await publishElsewhere(artifactId, "# Plan\n\nThe person's second edit.\n")
    write("work/plan/document.md", "# Plan\n\nThe Agent's second edit.\n")
    const refused = await version
      .execute(version.parseInput({ id: artifactId, path: "work/plan", title: "Plan" }), context)
      .catch((error: unknown) => error)
    expect(version.errorText(refused)).toContain(
      "and written into work/plan, the folder you published it from"
    )
    expect(read("work/plan/document.md")).toBe("# Plan\n\nThe person's second edit.\n")
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
    const served = (id: string) => JSON.parse(read(`.sixb/agent/checks/${id}-r1/files.json`))
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
      "examples/page/collections-desk",
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

describe("the sixb-artifacts skill's live page", () => {
  afterEach(() => setSystemTime())

  test("shows a value the reader may not see as locked, and totals nothing over it", async () => {
    // The page example the Agent copies for live rows: an amount the reader isn't cleared for is
    // in the row's `redactions`, not its `properties`. Reproduce by computing collections-desk's
    // outstanding amount as `(amount ?? 0) - (paid ?? 0)` for every row again: the tile adds the
    // hidden amount as 0, and its row reads $0.
    const skill = BUILT_IN_SKILLS.find((candidate) => candidate.name === "sixb-artifacts")
    const html = String(
      skill?.files.find((file) => file.path === "examples/page/collections-desk/index.html")
        ?.contents
    )
    const script = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1] ?? ""
    const page = fakePage()

    const invoice = (number: string, properties: Record<string, unknown>) => ({
      primaryId: number,
      objectTypeId: "Invoice",
      properties: { number, dueDate: "2026-09-01", paid: 0, ...properties },
    })
    const objects = [
      invoice("INV-1", { amount: 1000 }),
      { ...invoice("INV-2", {}), redactions: { amount: { reason: "missing_clearance" } } },
    ]
    const sixb = { query: async () => ({ kind: "objects", objects, total: 2, truncated: false }) }

    setSystemTime(new Date("2026-10-23T12:00:00.000Z"))
    const run = Object.getPrototypeOf(async () => {}).constructor("sixb", "document", script)
    await run(sixb, page.document)

    const money = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    })
    expect(page.byId("outstanding").textContent).toBe("Locked")
    expect(page.byId("outstanding-locked").textContent).toBe(
      "You don't have permission to see Amount"
    )
    expect(page.byId("rows").children.map((row) => row.children.at(-1)?.textContent)).toEqual([
      money.format(1000),
      "Locked",
    ])
    // What reads no amount still counts every row.
    expect(page.byId("count").textContent).toBe("2")
  })
})

/** Just enough of a document for the example's script: elements by id, and the age chips. */
function fakePage() {
  class Element {
    textContent = ""
    className = ""
    title = ""
    innerHTML = ""
    value = ""
    children: Element[] = []
    readonly classes = new Set<string>()
    readonly classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, on: boolean) =>
        on ? this.classes.add(name) : this.classes.delete(name),
    }
    append(child: Element) {
      this.children.push(child)
    }
    replaceChildren(...children: Element[]) {
      this.children = children
    }
    addEventListener() {}
  }

  const elements = new Map<string, Element>()
  const byId = (id: string) => {
    const known = elements.get(id) ?? new Element()
    elements.set(id, known)
    return known
  }
  const chip = Object.assign(new Element(), { value: "0" })
  const document = {
    querySelector: (selector: string) =>
      selector.startsWith("#") ? byId(selector.slice(1)) : chip,
    querySelectorAll: () => [chip],
    createElement: () => new Element(),
  }
  return { document, byId }
}

describe("materializeThreadArtifacts", () => {
  test("installs the thread's latest versions, newest first, within the byte budget", async () => {
    // Reproduce the pins by listing them for open versions too: the Agent's reply then pins
    // content its next update replaces.
    const freeze = (artifactId: string) =>
      storage.artifacts.freeze({ projectId, artifactId, frozenAt: new Date(), frozenBy: owner })
    write("a/document.md", "# First\n\nOne.\n")
    write("b/document.md", "# Second\n\nTwo.\n")
    const first = (await publish({ path: "a", kind: "document", title: "First" })) as {
      artifactId: string
    }
    // The user creates version 1; the update opens version 2.
    await freeze(first.artifactId)
    write("a/document.md", "# First\n\nOne, revised.\n")
    await publishVersion({ id: first.artifactId, path: "a", title: "First" })
    const second = (await publish({ path: "b", kind: "document", title: "Second" })) as {
      artifactId: string
    }
    await freeze(second.artifactId)

    const installed = await install()

    expect(JSON.parse(installed.manifestJson)).toEqual({
      artifacts: [
        {
          id: second.artifactId,
          kind: "document",
          title: "Second",
          version: 1,
          revision: 2,
          open: false,
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
          revision: 3,
          open: true,
          address: `artifact:${first.artifactId}`,
          parts: [{ address: `artifact:${first.artifactId}#first`, name: "First" }],
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
      revision: 3,
      open: true,
      address: `artifact:${first.artifactId}`,
      parts: [{ address: `artifact:${first.artifactId}#first`, name: "First" }],
      files: ["document.md"],
    })
    expect(bounded.files).toHaveLength(1)

    const elsewhere = await materializeThreadArtifacts({
      threadId: "thr_other",
      artifacts: runArtifactsFor({ run: await startRun("thr_other", owner) }),
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

    // The person saves in the app: no thread origin.
    const first = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
    if (!first) throw new Error("Version 1 was not stored.")
    const {
      projectId: _project,
      artifactId: _artifact,
      version: _version,
      revision: _revision,
      origin: _origin,
      createdAt: _created,
      ...content
    } = first
    await storage.artifacts.publish({
      projectId,
      artifactId,
      kind: "document",
      version: { ...content, updatedAt: new Date() },
      baseRevision: 1,
    })
    // Reproduce by marking every entry: the Agent's own writes read as edited too.
    expect(JSON.parse((await install()).manifestJson).artifacts[0]).toMatchObject({
      version: 1,
      revision: 2,
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
      version: 1,
      revision: 2,
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
    // Pinned too once the user created the version.
    await storage.artifacts.freeze({ projectId, artifactId, frozenAt: new Date(), frozenBy: owner })
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
        `[SixbAgent] Could not install revision 1 of artifact '${first.artifactId}'`
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
      artifacts: runArtifactsFor(),
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

    const checks = `.sixb/agent/checks/${published.artifactId}-r1`
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

    const checks = `.sixb/agent/checks/${published.artifactId}-r1`
    expect(JSON.parse(read(`${checks}/queries.json`))).toEqual({ invoices: 409 })
    expect(JSON.parse(read(`${checks}/queries/invoices.json`))).toEqual({
      error: "Principal 'usr_owner' is not allowed to view object type 'Invoice'.",
    })
  })
})
