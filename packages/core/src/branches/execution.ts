import { randomBytes } from "node:crypto"
import { assertAuthorized } from "../authorization"
import { branchRefusal } from "../branch-mode/refusals"
import type { ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  BranchChanges,
  BranchData,
  BranchError,
  BranchNotice,
  BranchRecord,
  BranchState,
  BranchStorage,
  BranchWanted,
} from "../storage/branches"
import { branchNamespaceName } from "./data"
import {
  BRANCH_HANDOVER_PREPARE_PATH,
  BRANCH_HANDOVER_SIGN_IN_PATH,
  type BranchHandoverPerson,
} from "./handover"
import { branchPreviewOrigin } from "./preview"
import { BRANCH_KEY_HEADER } from "./runtime"
import { assertGitBranchName, type ProjectSource } from "./source"

/** How often a write retries over a row its worker moved on meanwhile. */
const WANT_ATTEMPTS = 5

/** A branch as the people who manage branches see it: never its key or its sandbox's address. */
export interface BranchView {
  readonly name: string
  readonly wanted: BranchWanted
  readonly state: BranchState
  readonly createdBy: string
  readonly generation: number | null
  readonly commit: string | null
  readonly error: BranchError | null
  /** Why production could not read the repository's branches, while the branch waits for it. */
  readonly remoteError: string | null
  /** What its creator should know, such as a copy taken again because its machine was lost. */
  readonly notices: readonly BranchNotice[]
  /** The copy it runs on: when production took it, and what it left out. */
  readonly data: BranchData | null
  readonly refreshRequestedAt: Date | null
  readonly openedAt: Date
  readonly lastSeenAt: Date
}

/**
 * The branches that run next to production. Opening one copies what you read in production into
 * a schema of its own and runs the git branch's code on it; refreshing takes a new copy, which
 * discards what the branch wrote; deleting drops its sandbox, its schema and its role. A branch
 * worker (`sixb worker branches`) does the work: these only say what is wanted.
 */
export interface BranchesRuntime {
  list(): Promise<readonly BranchView[]>
  get(name: string): Promise<BranchView | null>
  /** Opens the git branch, or opens it again: it starts, and stays up while someone reaches it. */
  open(name: string): Promise<BranchView>
  /** Takes a new copy of production for it. What the branch wrote is discarded. */
  refresh(name: string): Promise<BranchView>
  /** Stops its runtime. Its copy stays, until it goes 14 days unopened. */
  stop(name: string): Promise<BranchView>
  /** Drops its sandbox, its schema and its role, then forgets it. */
  delete(name: string): Promise<BranchView>
  /**
   * Lets you into a running branch: the branch prepares a session for you, and the returned URL,
   * on the branch's own origin, trades a one-time code for it. Open it within a minute.
   */
  signIn(name: string): Promise<{ readonly url: string }>
}

export interface BranchesRuntimeDependencies {
  readonly source: ProjectSource | null
}

export function createBranchesRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  dependencies: BranchesRuntimeDependencies
): BranchesRuntime {
  const { projectId } = runtime

  const store = (): BranchStorage => {
    assertMayManageBranches(runtime)

    if (runtime.branch) {
      throw branchRefusal(
        runtime.branch,
        "branches are opened in production, not from another branch. Open it in production."
      )
    }
    if (!runtime.storage.hostedBranches) {
      throw new Error(
        "[Sixb] Hosted branches live on production's PostgreSQL instance: use @sixb/pg for production's storage."
      )
    }
    return runtime.storage.hostedBranches
  }

  /**
   * Writes what is wanted over the row as read, again if its worker moved it on meanwhile: a
   * write never lands on a row it did not check. `refuse` names why a row takes no such write.
   */
  const want = async (
    name: string,
    changes: (branch: BranchRecord) => BranchChanges,
    refuse: (branch: BranchRecord) => string | null = () => null
  ): Promise<BranchView> => {
    const branches = store()

    for (let attempt = 0; attempt < WANT_ATTEMPTS; attempt += 1) {
      const branch = await branches.get({ projectId, name })
      if (!branch) throw new Error(`[Sixb] There is no branch '${name}'. Open it first.`)

      const refusal = refuse(branch)
      if (refusal) throw new Error(`[Sixb] Branch '${name}' ${refusal}`)

      const written = await branches.update(
        { projectId, name, revision: branch.revision, at: new Date() },
        changes(branch)
      )
      if (written) return toBranchView(written)
    }
    throw new Error(`[Sixb] Branch '${name}' kept changing: try again.`)
  }

  const deleting = (branch: BranchRecord) =>
    branch.wanted === "deleted" ? "is being deleted. Open it again once it is gone." : null

  return {
    list: async () => (await store().list({ projectId })).map(toBranchView),

    get: async (name) => {
      const branch = await store().get({ projectId, name })
      return branch ? toBranchView(branch) : null
    },

    open: async (name) => {
      const branches = store()
      assertGitBranchName(name)
      if (!dependencies.source) {
        throw new Error(
          "[Sixb] Branches run the project's code from its repository: name it with createSixb({ source: { repository } })."
        )
      }

      const creator = execution.requestedBy
      if (creator?.type !== "user") {
        throw new Error("[Sixb] A branch copies what one person reads: only a person opens one.")
      }

      const now = new Date()
      const { branch, created } = await branches.create({
        projectId,
        name,
        namespace: branchNamespaceName(name),
        wanted: "running",
        state: "stopped",
        createdBy: creator.id,
        key: randomBytes(32).toString("base64url"),
        port: null,
        sandbox: null,
        url: null,
        generation: null,
        commit: null,
        error: null,
        data: null,
        refreshRequestedAt: null,
        remoteCommit: null,
        remoteError: null,
        notices: [],
        owner: null,
        leaseExpiresAt: null,
        createdAt: now,
        openedAt: now,
        lastSeenAt: now,
      })
      if (created) return toBranchView(branch)

      return want(name, () => ({ wanted: "running", openedAt: now, lastSeenAt: now }), deleting)
    },

    refresh: (name) => {
      const now = new Date()
      return want(
        name,
        () => ({ wanted: "running", refreshRequestedAt: now, lastSeenAt: now }),
        deleting
      )
    },

    stop: (name) => want(name, () => ({ wanted: "stopped" }), deleting),

    delete: (name) => want(name, () => ({ wanted: "deleted" })),

    signIn: async (name) => {
      const branches = store()
      const branch = await branches.get({ projectId, name })
      if (!branch) throw new Error(`[Sixb] There is no branch '${name}'. Open it first.`)
      if (branch.state !== "ready" || !branch.url) {
        throw new Error(`[Sixb] Branch '${name}' is not ready yet: it is ${branch.state}.`)
      }

      const person = await signingIn(runtime, execution)
      const response = await fetch(new URL(BRANCH_HANDOVER_PREPARE_PATH, branch.url), {
        method: "POST",
        headers: { "content-type": "application/json", [BRANCH_KEY_HEADER]: branch.key },
        body: JSON.stringify(person),
        signal: AbortSignal.timeout(HANDOVER_TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new Error(`[Sixb] Branch '${name}' did not answer: ${errorMessage(error)}`)
      })
      const answer = (await response.json().catch(() => null)) as { code?: unknown } | null
      if (!response.ok || typeof answer?.code !== "string") {
        throw new Error(`[Sixb] Branch '${name}' did not let you in (HTTP ${response.status}).`)
      }

      const origin = branchPreviewOrigin(branch, dependencies.source?.previewDomain ?? null)
      const url = new URL(BRANCH_HANDOVER_SIGN_IN_PATH, origin ?? branch.url)
      url.searchParams.set("code", answer.code)
      return { url: url.toString() }
    },
  }
}

/** How long production waits for a branch to prepare a session. */
const HANDOVER_TIMEOUT_MS = 10_000

/** The person signing in, as production knows them: who the branch lets in. */
async function signingIn(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext
): Promise<BranchHandoverPerson> {
  const requester = execution.requestedBy
  if (requester?.type !== "user") {
    throw new Error("[Sixb] Only a person signs into a branch.")
  }
  const auth = runtime.storage.auth
  if (!auth) throw new Error("[Sixb] Signing into a branch takes storage.auth's members.")

  const user = await auth.users.getById({ projectId: runtime.projectId, id: requester.id })
  if (!user || user.status !== "active") {
    throw new Error(`[Sixb] '${requester.id}' is not an active member.`)
  }
  const memberships = await auth.groupMemberships.listForUser({
    projectId: runtime.projectId,
    userId: user.id,
  })
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
    groupIds: memberships.map((membership) => membership.groupId),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Who may open, view, refresh, stop, delete and sign into branches: whoever manages the project's
 * code. A branch's code can widen what it does with its creator's data, so the people who see a
 * branch stay a trusted set.
 */
export function assertMayManageBranches(runtime: SixbRuntimeContext): void {
  assertAuthorized(runtime, { kind: "source.manage" })
}

export function toBranchView(branch: BranchRecord): BranchView {
  return {
    name: branch.name,
    wanted: branch.wanted,
    state: branch.state,
    createdBy: branch.createdBy,
    generation: branch.generation,
    commit: branch.commit,
    error: branch.error,
    remoteError: branch.remoteError,
    notices: branch.notices,
    data: branch.data,
    refreshRequestedAt: branch.refreshRequestedAt,
    openedAt: branch.openedAt,
    lastSeenAt: branch.lastSeenAt,
  }
}
