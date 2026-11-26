import { afterEach, beforeEach, jest, spyOn } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type OntologyRegistry,
  project,
  prop,
  resolveAuthorizationContext,
  type Sandbox,
  type SandboxFactory,
  type SandboxStatus,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import {
  BRANCH_CHECKOUT_MARK,
  BRANCH_INSTALL_COMMAND,
  BRANCH_KEY_HEADER,
  BRANCH_STATUS_PATH,
  type BranchClosure,
  readBranchCopy,
} from "@sixb/core/internal/branches"
import { importSnapshot } from "@sixb/core/internal/snapshots"
import type { CreateSandboxOptions, SandboxSourceAuth } from "@sixb/core/sandboxes"
import { createTestSixb } from "@sixb/core/testing"
import * as copyModule from "../../src/copy"
import {
  BRANCH_LEASE_MS,
  BRANCH_TICK_MS,
  HeldBranch,
  type HeldBranchSettings,
} from "../../src/held-branch"
import * as stagingModule from "../../src/staging"
import { gitRepository } from "./git"

// A shop's production, a fake sandbox provider and a fake runtime front: what the worker does
// with a branch, decision by decision, on a fake clock. The e2e test runs the real thing.

export const projectId = "branch-worker"
export const NAME = "feature/invoices"

const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const staff = defineRole("staff", {
  grantedTo: [defineGroup("staff")],
  grants: [can.view(Order), can.manage(project.source)],
})

const cleanups: (() => Promise<unknown> | unknown)[] = []

// The clock is fake, the worker's I/O is not: it reads its runtime's front over HTTP, stages a
// copy on disk and clears what a dead worker staged. Work still running when the clock moves on
// sees time jump under it on a busy runner: the branch never answers, nobody ever used it, the
// copy outlasts its bound. `flush` waits for that work, except where a test's gate holds it.
// To see it fail without: have the front answer 50 ms late (`await Bun.spawn(["sleep", "0.05"])
// .exited` in its `fetch`), and most of the worker's tests fail.

// Each test's own: work a test left behind is no later test's to wait for.
let pending = { work: new Set<Promise<unknown>>(), held: 0 }

function track<T>(promise: Promise<T>): Promise<T> {
  const { work } = pending
  work.add(promise)
  void promise.catch(() => {}).finally(() => work.delete(promise))
  return promise
}

/**
 * Waits at a test's gate inside the work `flush` waits for: the copy held there on purpose is not
 * waited for. Gates outside that work (a sandbox's create, the runtime's load) need none.
 */
export async function atGate(gate: Promise<void> | null): Promise<void> {
  if (!gate) return
  const counted = pending
  counted.held += 1
  try {
    await gate
  } finally {
    counted.held -= 1
  }
}

/** Runs each test of the file on a fake clock, and cleans up after it. */
export function useLab(): void {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-11-24T12:00:00.000Z") })
    pending = { work: new Set(), held: 0 }

    const realFetch = globalThis.fetch
    const fetchWhole = async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args)
      return new Response(await response.arrayBuffer(), response)
    }
    const reads = spyOn(globalThis, "fetch").mockImplementation(((
      ...args: Parameters<typeof fetch>
    ) => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0])
      if (new URL(url).pathname !== BRANCH_STATUS_PATH) return realFetch(...args)
      return track(fetchWhole(...args))
    }) as typeof fetch)

    const deliver = copyModule.copyIntoSandbox
    const copies = spyOn(copyModule, "copyIntoSandbox").mockImplementation((...args) =>
      track(deliver(...args))
    )

    const clear = stagingModule.clearStaleStaging
    const clears = spyOn(stagingModule, "clearStaleStaging").mockImplementation(() =>
      track(clear())
    )

    onCleanup(() => {
      reads.mockRestore()
      copies.mockRestore()
      clears.mockRestore()
    })
  })
  afterEach(async () => {
    jest.useRealTimers()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
}

export function onCleanup(cleanup: () => Promise<unknown> | unknown): void {
  cleanups.push(cleanup)
}

/** What the fake runtime's front answers, and what the fake provider and instance saw. */
export interface Lab {
  /** Resumes a stopped sandbox, as a provider that persists one does. */
  resumable: boolean
  /** Holds every create until it settles: a clone that takes its time. */
  createGate: Promise<void> | null
  /** Holds every copy's way into the sandbox until it settles: a large copy. */
  copyGate: Promise<void> | null
  /** Holds every load of a copy by the runtime until it settles: a large load. */
  importGate: Promise<void> | null
  /** The runtime loads a copy: its front says it is starting. */
  loading: boolean
  /** The copy the runtime loaded, as its front reports it. */
  loaded: Record<string, unknown> | null
  requests: number
  /** False for a front that does not answer, as a runtime that never came up. */
  answering: boolean
  /** Where a front sends its status read instead of answering: branch code that redirects. */
  redirect: string | null
  state: "starting" | "ready" | "failed"
  /** What the provider says of every sandbox. */
  sandboxStatus: SandboxStatus
  /** The sandboxes stopped, in order. */
  stopped: string[]
  /** Holds every sandbox stop until it settles: a provider saving a snapshot. */
  stopGate: Promise<void> | null
  /** The commit the sandbox's checkout is at. */
  head: string
  /** What a pull in the sandbox brings, and the files it changes. */
  remoteHead: string
  changedFiles: string[]
  /** How many times production held the branch's role to its limits. */
  enforced: number
  /** How many times production made the branch's database and role anew, for a copy. */
  prepared: number
  /** The branches whose login production took away, in order. */
  readonly closed: string[]
  /** What the next round of the limits finds: production closes the branch, once. */
  closure: BranchClosure | null
  /** What the next drop of the branch's data throws, once. */
  dropFailure: Error | null
  /** Every drop of the branch's data fails while set. */
  dropsFail: boolean
  /** How many times production was asked to drop the branch's data. */
  drops: number
  /** Thrown by the next sandbox destroy, once. */
  destroyFailure: Error | null
  /** Thrown by the next resumes, one each, before a resume succeeds again. */
  resumeFailures: Error[]
  /** The names the provider keeps a saved sandbox under. */
  readonly saved: Set<string>
  /** The names resumed, in order. */
  readonly resumed: string[]
  /** The names stopped by name, in order: sessions a dead worker left running. */
  readonly stoppedByName: string[]
  /** Fails the first checkout step whose script holds `step`, as that command would. */
  checkoutFailure: {
    readonly step: string
    readonly stderr: string
    readonly timedOut?: boolean
  } | null
  /** The scripts of every checkout step run, in order. */
  readonly checkout: string[]
  /** The sandboxes whose checkout finished, by name or id. */
  readonly marked: Set<string>
  /** Whether production may cap a branch role's temporary files. */
  tempFileLimit: boolean
  readonly created: CreateSandboxOptions[]
  readonly destroyed: string[]
  readonly started: Record<string, string>[]
  readonly kills: number[]
  readonly imports: string[]
  readonly installs: string[]
  readonly pulls: string[]
  readonly files: Map<string, string | Uint8Array>
  /** Each started runtime's exit, to end it as a crash would. */
  readonly exits: ((code: number) => void)[]
}

function fakeSandboxes(
  lab: Lab,
  front: string,
  storage: InMemoryStorage,
  /** The branch's definitions, which its own `sixb dev` checks the copy against. */
  ontology: () => OntologyRegistry,
  recipe: { readonly env?: Readonly<Record<string, string>>; readonly auth?: SandboxSourceAuth }
): SandboxFactory {
  const recipeEnv = recipe.env
  const sandbox = (id: string, name?: string): Sandbox => ({
    id,
    provider: "fake",
    get status() {
      return lab.sandboxStatus
    },
    workingDirectory: "/work",
    async runCommand(command, args = [], options) {
      options?.signal?.throwIfAborted()
      const script = args[1] ?? ""
      const result = (stdout = "", exitCode = 0) => ({
        exitCode,
        stdout,
        stderr: "",
        timedOut: false,
        durationMs: 1,
      })

      // A new sandbox's checkout, step by step, until its last step marks it done.
      const key = name ?? id
      if (command === "test" && args[1] === BRANCH_CHECKOUT_MARK) {
        return result("", lab.marked.has(key) ? 0 : 1)
      }
      if (command === "sh" && !lab.marked.has(key)) {
        lab.checkout.push(script)
        const failure = lab.checkoutFailure
        if (failure && script.includes(failure.step)) {
          lab.checkoutFailure = null
          return { ...result("", 1), stderr: failure.stderr, timedOut: failure.timedOut ?? false }
        }
        if (script === `touch ${BRANCH_CHECKOUT_MARK}`) lab.marked.add(key)
        return result()
      }

      if (command === "git" && args[0] === "rev-parse") return result(`${lab.head}\n`)
      if (command === "sh" && script.includes("git fetch")) {
        return result(lab.changedFiles.map((file) => `${file}\n`).join(""))
      }
      if (command === "sh" && script.includes("git reset")) {
        lab.pulls.push(lab.remoteHead)
        lab.head = lab.remoteHead
        return result()
      }
      if (command === "sh" && script === BRANCH_INSTALL_COMMAND) {
        lab.installs.push(lab.head)
        return result()
      }
      // The copy's parts, cleared, then joined where the runtime finds it, as the shell does.
      if (command === "sh" && script.includes("mkdir -p")) removeUnder(lab, args[2] ?? "")
      if (command === "sh" && script.includes("cat ")) {
        const [parts = "", target = ""] = args.slice(2)
        const keys = [...lab.files.keys()].filter((path) => path.startsWith(`${parts}/`)).sort()
        lab.files.set(target, Buffer.concat(keys.map((key) => lab.files.get(key) as Uint8Array)))
        removeUnder(lab, parts)
      }
      return result()
    },
    async writeFiles(files) {
      if (files.some((file) => file.path.includes(".parts/"))) await atGate(lab.copyGate)
      for (const file of files) lab.files.set(file.path, file.contents)
    },
    start: async (_command, _args, options) => {
      // A provider gives its recipe's env to everything it runs, as every provider does.
      lab.started.push({ ...recipeEnv, ...options?.env })
      // The branch's own `sixb dev` loads a copy production delivered, as a laptop's does.
      const copy = [...lab.files.keys()].find((path) => path.endsWith("/hosted.copy"))
      if (copy) {
        lab.loading = true
        void (async () => {
          await lab.importGate
          const schema = options?.env?.SIXB_BRANCH_DATABASE_SCHEMA ?? ""
          lab.imports.push(schema)
          const delivered = readBranchCopy(
            (async function* () {
              yield new Uint8Array(lab.files.get(copy) as Uint8Array)
            })()
          )
          const report = await importSnapshot({
            snapshot: delivered.snapshot,
            storage: (await storage.openBranchNamespace(schema.replace(/^branch_/, "")))!,
            ontology: ontology(),
          })
          const rest = await delivered.rest()
          lab.files.delete(copy)
          lab.files.delete(`${copy}.json`)
          lab.loaded = {
            takenAt: report.takenAt,
            objects: report.types.reduce((total, type) => total + type.objects, 0),
            skipped: report.skipped,
            lakeSliceId: rest?.lake.sliceId ?? null,
          }
          lab.loading = false
        })()
      }
      const index = lab.started.length
      let exit: (code: number) => void = () => {}
      const exited = new Promise<number>((resolve) => {
        exit = resolve
      })
      lab.exits.push(exit)
      return {
        exited,
        kill: async () => {
          lab.kills.push(index)
          exit(137)
        },
      }
    },
    url: () => front,
    keepAlive: async () => {},
    async stop() {
      await lab.stopGate
      lab.stopped.push(id)
    },
    async destroy() {
      const failure = lab.destroyFailure
      lab.destroyFailure = null
      if (failure) throw failure
      lab.destroyed.push(id)
      if (name) lab.saved.delete(name)
    },
  })

  // A provider that saves sandboxes, as Vercel does: by name, deleted by name.
  const saving: Pick<SandboxFactory, "resume" | "destroy" | "stop"> = {
    async stop(name) {
      lab.stoppedByName.push(name)
    },
    async resume(name) {
      const failure = lab.resumeFailures.shift()
      if (failure) throw failure
      lab.resumed.push(name)
      return sandbox(name, name)
    },
    async destroy(name) {
      const failure = lab.destroyFailure
      lab.destroyFailure = null
      if (failure) throw failure
      if (lab.saved.delete(name)) lab.destroyed.push(name)
    },
  }

  return {
    supportsRequestCredentials: true,
    runsBranches: true,
    ...(recipe.env || recipe.auth ? { configuration: recipe } : {}),
    async create(options) {
      await lab.createGate
      const name = options?.persistence?.name
      if (name && lab.saved.has(name)) throw new Error(`A sandbox named '${name}' already exists.`)

      lab.created.push(options ?? {})
      if (name) lab.saved.add(name)
      return sandbox(`sandbox-${lab.created.length}`, name)
    },
    ...(lab.resumable ? saving : {}),
  }
}

function removeUnder(lab: Lab, prefix: string): void {
  for (const path of [...lab.files.keys()]) {
    if (path === prefix || path.startsWith(`${prefix}/`)) lab.files.delete(path)
  }
}

export async function setup(
  options: {
    readonly resumable?: boolean
    readonly recipeEnv?: Readonly<Record<string, string>>
    /** The project's source authentication, as a private repository needs. */
    readonly auth?: SandboxSourceAuth
    readonly host?: Partial<SixbHostOptions>
  } = {}
) {
  const repository = await gitRepository()
  onCleanup(() => repository.remove())
  await repository.branch(NAME)
  await repository.commit(NAME, "invoices.ts")

  const lab: Lab = {
    resumable: options.resumable ?? false,
    createGate: null,
    copyGate: null,
    importGate: null,
    loading: false,
    loaded: null,
    requests: 0,
    answering: true,
    redirect: null,
    state: "ready",
    sandboxStatus: "running",
    stopped: [],
    stopGate: null,
    head: await repository.head(NAME),
    remoteHead: await repository.head(NAME),
    changedFiles: [],
    enforced: 0,
    prepared: 0,
    closed: [],
    closure: null,
    dropFailure: null,
    dropsFail: false,
    drops: 0,
    destroyFailure: null,
    resumeFailures: [],
    saved: new Set(),
    resumed: [],
    stoppedByName: [],
    checkoutFailure: null,
    checkout: [],
    marked: new Set(),
    tempFileLimit: true,
    created: [],
    destroyed: [],
    started: [],
    kills: [],
    imports: [],
    installs: [],
    pulls: [],
    files: new Map(),
    exits: [],
  }

  // On the address the worker reads, not every address: a port the kernel hands out on every
  // address can still be held on loopback by another process, which then answers the read.
  const front = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get(BRANCH_KEY_HEADER) === null) {
        return new Response(null, { status: 401 })
      }
      if (lab.redirect) return Response.redirect(lab.redirect, 307)
      if (new URL(request.url).pathname !== BRANCH_STATUS_PATH || !lab.answering) {
        return new Response(null, { status: 404 })
      }
      return Response.json({
        branch: NAME,
        generation: lab.started.length,
        state: lab.loading ? "starting" : lab.state,
        commit: lab.head,
        error: null,
        requests: lab.requests,
        copy: lab.loaded,
      })
    },
  })
  onCleanup(() => front.stop(true))

  const storage = new InMemoryStorage()
  // In memory there is no instance to host a role on: a namespace stands for the schema, and the
  // login answers as PostgreSQL's would. `hosted-branch.e2e.ts` runs the real one.
  Object.assign(storage, {
    createHostedBranch: async (name: string) => {
      lab.prepared += 1
      await storage.createBranchNamespace(name)
      return { tempFileLimit: lab.tempFileLimit }
    },
    openHostedBranch: async (name: string) => ({
      url: `postgres://branch:${crypto.randomUUID().replaceAll("-", "")}@db/prod`,
      schemaName: `branch_${name}`,
    }),
    dropHostedBranch: async (name: string) => {
      lab.drops += 1
      if (lab.dropsFail) throw new Error("lock timeout")
      const failure = lab.dropFailure
      lab.dropFailure = null
      if (failure) throw failure
      await storage.dropBranchNamespace(name)
    },
    enforceHostedBranchLimits: async () => {
      lab.enforced += 1
      const closed = lab.closure
      lab.closure = null
      return { stopped: 0, closed }
    },
    closeHostedBranch: async (name: string) => {
      lab.closed.push(name)
    },
    unmetHostedBranchRequirement: async () => null,
    hostedBranchDatabaseAddress: () => ({ host: "10.0.0.7", port: 5432 }),
  })

  const definitions: { ontology?: OntologyRegistry } = {}
  const host = new SixbHost({
    id: projectId,
    ontology: [Order],
    groups: [defineGroup("staff")],
    roles: [staff],
    source: { repository: repository.path },
    sandboxes: fakeSandboxes(
      lab,
      `http://127.0.0.1:${front.port}`,
      storage,
      () => {
        if (!definitions.ontology) throw new Error("The host has no ontology yet.")
        return definitions.ontology
      },
      {
        ...(options.recipeEnv ? { env: options.recipeEnv } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
      }
    ),
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    ...options.host,
  })
  definitions.ontology = host.definitions.ontology as OntologyRegistry

  await storage.auth.users.create({ projectId, id: "usr_bo", email: "bo@example.com" })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: "usr_bo",
    groupId: "staff",
    source: "manual",
  })
  await createTestSixb(host)
    .objects(Order)
    .upsert({ properties: { id: "ord-1" } })

  const bo = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_bo" },
      groupIds: ["staff"],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  await bo.branches.open(NAME)
  // The remote has it: the worker's read of the remote would say so.
  await storage.hostedBranches.update(
    { projectId, name: NAME, at: new Date() },
    { remoteCommit: await repository.head(NAME) }
  )

  return { lab, host, storage, bo, repository }
}

export const settings: HeldBranchSettings = {
  owner: "worker-test",
  apiPublicOrigin: "https://api.shop.test",
  devEnv: async () => ({ STRIPE_KEY: "sk_test_dev" }),
  allow: [],
}

/** Claims the branch as the worker does, and holds it until the returned stop. */
export async function hold(host: SixbHost, overrides: Partial<HeldBranchSettings> = {}) {
  const branches = host.storage.hostedBranches!
  const row = (await branches.get({ projectId, name: NAME }))!
  const claimed = (await branches.update(
    { projectId, name: NAME, revision: row.revision, at: new Date() },
    { owner: settings.owner, leaseExpiresAt: new Date(Date.now() + BRANCH_LEASE_MS) }
  ))!

  const controller = new AbortController()
  const life = new HeldBranch(
    host,
    { ...settings, ...overrides },
    claimed,
    controller.signal
  ).life()
  return {
    life,
    stop: async () => {
      controller.abort()
      await settled(life)
    },
  }
}

/** Lets callbacks and I/O run, the clock still, until no work but what a gate holds is left. */
export async function flush(turns = 2_000): Promise<void> {
  const busy = () => pending.work.size > pending.held
  do {
    while (busy()) await new Promise<void>((resolve) => setImmediate(resolve))
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  } while (busy())
}

/** Ticks the clock until `done`, letting the work of each tick finish first. */
export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: { readonly stepMs?: number; readonly steps?: number } = {}
): Promise<T> {
  for (let step = 0; step < (options.steps ?? 100); step += 1) {
    await flush()
    const value = await read()
    if (done(value)) return value
    jest.advanceTimersByTime(options.stepMs ?? BRANCH_TICK_MS)
  }
  throw new Error(`Never came: ${JSON.stringify(await read())}`)
}

/** Ticks the clock until `work` settles. */
export async function settled(work: Promise<unknown>): Promise<void> {
  let done = false
  void work.finally(() => {
    done = true
  })
  for (let step = 0; step < 100 && !done; step += 1) {
    await flush()
    if (!done) jest.advanceTimersByTime(BRANCH_TICK_MS)
  }
  await work
}

/** Moves the clock `ms` on, a tick at a time, letting each tick's work run. */
export async function pass(ms: number, turns = 500): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += BRANCH_TICK_MS) {
    jest.advanceTimersByTime(BRANCH_TICK_MS)
    await flush(turns)
  }
}

export const row = (host: SixbHost) => () =>
  host.storage.hostedBranches!.get({ projectId, name: NAME })
export const ready = (host: SixbHost) => until(row(host), (branch) => branch?.state === "ready")
