import { randomBytes } from "node:crypto"
import { assertAuthorized } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import { assertBranchName, type ProjectSource } from "../sandboxes/source"
import type { BranchRecord, BranchStorage } from "../storage/branches"

/** A branch as whoever works on the project sees it: never its key, its sandbox or its lease. */
export type BranchView = Pick<
  BranchRecord,
  | "name"
  | "wanted"
  | "state"
  | "generation"
  | "commit"
  | "manifest"
  | "error"
  | "createdBy"
  | "createdAt"
  | "updatedAt"
  | "lastSeenAt"
>

/** Where the project's server forwards a branch's requests, and the key it adds. */
export interface BranchRoute {
  readonly state: BranchRecord["state"]
  readonly url: string | null
  readonly key: string
}

export type BranchRequestErrorCode = "branches_unavailable" | "invalid_branch" | "branch_not_found"

export class BranchRequestError extends Error {
  readonly name = "BranchRequestError"
  constructor(
    readonly code: BranchRequestErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** A request's view of the project's branches, for whoever may manage its source. */
export interface ProjectBranches {
  list(): Promise<readonly BranchView[]>
  get(name: string): Promise<BranchView | null>
  /** Wants the branch running, adding it when it's new: a worker starts its runtime. */
  open(name: string): Promise<BranchView>
  /** Wants it stopped: its runtime stops, and its sandbox keeps what it held for the next open. */
  stop(name: string): Promise<BranchView>
  /** Where to forward the branch's requests. Each visit keeps it from stopping as idle. */
  route(name: string): Promise<BranchRoute | null>
}

/** How often a visit is written down: the runtime stops after minutes without one, not seconds. */
const SEEN_EVERY_MS = 60_000
/** The ports a branch's runtime is given, one per branch: free on a laptop more often than not. */
const PORTS = { from: 41_000, count: 8_000 }

export function createProjectBranches(
  runtime: SixbRuntimeContext,
  input: {
    readonly source: ProjectSource | undefined
    readonly storage: BranchStorage | undefined
    readonly requestedBy: string | null
  }
): ProjectBranches {
  const projectId = runtime.projectId
  const available = (): BranchStorage => {
    assertAuthorized(runtime, { kind: "source.manage" })
    if (!input.source || !input.storage) {
      throw new BranchRequestError(
        "branches_unavailable",
        "[Sixb] Branches need createSixb({ source }), sandboxes and a storage that keeps branches."
      )
    }
    return input.storage
  }
  const named = (name: string): string => {
    try {
      assertBranchName(name)
    } catch (error) {
      throw new BranchRequestError("invalid_branch", (error as Error).message)
    }
    return name
  }

  return {
    async list() {
      return (await available().list({ projectId })).map(viewOf)
    },
    async get(name) {
      const branch = await available().get({ projectId, name: named(name) })
      return branch ? viewOf(branch) : null
    },
    async open(name) {
      const storage = available()
      const now = new Date()
      const { branch, created } = await storage.create({
        projectId,
        name: named(name),
        wanted: "running",
        state: "stopped",
        key: randomBytes(32).toString("hex"),
        port: PORTS.from + Math.floor(Math.random() * PORTS.count),
        sandbox: null,
        url: null,
        generation: null,
        commit: null,
        manifest: null,
        error: null,
        pushedAt: null,
        pulledAt: null,
        owner: null,
        leaseExpiresAt: null,
        createdBy: input.requestedBy,
        createdAt: now,
        lastSeenAt: now,
      })
      if (created) return viewOf(branch)
      const opened = await storage.update(
        { projectId, name, at: now },
        {
          wanted: "running",
          lastSeenAt: now,
          ...(branch.state === "failed" ? { error: null } : {}),
        }
      )
      return viewOf(opened ?? branch)
    },
    async stop(name) {
      const stopped = await available().update(
        { projectId, name: named(name), at: new Date() },
        { wanted: "stopped" }
      )
      if (!stopped) {
        throw new BranchRequestError("branch_not_found", `[Sixb] There is no branch '${name}'.`)
      }
      return viewOf(stopped)
    },
    async route(name) {
      const storage = available()
      const branch = await storage.get({ projectId, name: named(name) })
      if (!branch) return null
      const now = new Date()
      if (now.getTime() - branch.lastSeenAt.getTime() > SEEN_EVERY_MS) {
        await storage.update({ projectId, name, at: now }, { lastSeenAt: now })
      }
      return { state: branch.state, url: branch.url, key: branch.key }
    },
  }
}

function viewOf(branch: BranchRecord): BranchView {
  return {
    name: branch.name,
    wanted: branch.wanted,
    state: branch.state,
    generation: branch.generation,
    commit: branch.commit,
    manifest: branch.manifest,
    error: branch.error,
    createdBy: branch.createdBy,
    createdAt: branch.createdAt,
    updatedAt: branch.updatedAt,
    lastSeenAt: branch.lastSeenAt,
  }
}

const projectBranchesKey: unique symbol = Symbol("sixb.projectBranches")

interface ProjectBranchesOwner {
  readonly [projectBranchesKey]?: ProjectBranches
}

export function registerProjectBranches(owner: object, branches: ProjectBranches): void {
  Object.defineProperty(owner, projectBranchesKey, {
    configurable: false,
    enumerable: false,
    value: branches,
    writable: false,
  })
}

export function getProjectBranches(owner: object): ProjectBranches {
  const branches = (owner as ProjectBranchesOwner)[projectBranchesKey]
  if (!branches) throw new Error("[Sixb] Branches are not registered for this execution.")
  return branches
}
