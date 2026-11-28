import type { SixbBranch } from "../branch-mode"
import { putOnBranch } from "../branch-mode"
import type { LakeStorage } from "../lake-storage/types"
import { hostOptionsOf, SixbHost, type SixbHostView } from "../runtime/host"
import type { BranchData, BranchError, BranchState } from "../storage/branches"
import { parseCopyTypes } from "../storage/branches/record"
import type { Storage } from "../storage/types"
import { branchBlobStorage } from "./blobs"
import { branchHandoverAuth } from "./handover"
import { BRANCH_TOOLS_PATH } from "./source"

/**
 * What a branch knows of production, as `sixb dev --from production` set it up: on a laptop, or in
 * a sandbox next to production (`hosted`).
 */
export interface BranchRuntime {
  /** The person the copy was taken as: every local request runs as them. */
  readonly person: { readonly userId: string }
  /** Production's API, read as that person: its object files, and its lake's slice token. */
  readonly production: {
    readonly url: string
    authorization(): Promise<string>
  }
  /** When the copy was taken: the branch's data is production's as of then. */
  readonly takenAt: string
  /**
   * Set on a branch production runs: its front answers production with this key, and people at
   * this origin, where they open the branch. `productionOrigin` is production's app, which the
   * branch's bar links back to, when the deployment says where.
   */
  readonly hosted?: {
    readonly key: string
    readonly origin: string
    readonly productionOrigin: string | null
  }
}

const runtimes = new WeakMap<object, BranchRuntime>()

/** The branch runtime a host runs on, or null off a branch from production. */
export function branchRuntimeOf(host: object): BranchRuntime | null {
  return runtimes.get(host) ?? null
}

/**
 * The project's host, built again on the branch's own data: its storage namespace and its lake
 * slice in place of the providers the project configured, everything else as the project wrote
 * it. The host must already run as a branch, so every gate is on.
 */
export function hostOnBranch(
  host: SixbHostView,
  input: {
    readonly storage: Storage
    readonly lakeStorage?: LakeStorage
    readonly runtime: BranchRuntime
  }
): SixbHost {
  const branch: SixbBranch | null = host.branch
  if (!branch) {
    throw new Error("[Sixb] Only a host that runs as a branch is built on a branch's data.")
  }

  const project = hostOptionsOf(host as SixbHost)
  const options = putOnBranch(
    {
      ...project,
      storage: input.storage,
      ...(input.lakeStorage ? { lakeStorage: input.lakeStorage } : {}),
      // The copied objects' files stay in production: whatever reads them on the branch reads
      // them from there, as the person.
      blobStorage: branchBlobStorage({
        local: project.blobStorage,
        runtime: input.runtime,
        projectId: host.projectId,
        objects: input.storage.objects,
        objectTypes: () => host.definitions.ontology.listObjectTypes(),
      }),
      // A branch production runs signs people in only through production's handover.
      ...(input.runtime.hosted
        ? { auth: branchHandoverAuth(project.auth, input.runtime.hosted.origin) }
        : {}),
    },
    branch
  )
  const branchHost = new SixbHost(options)
  runtimes.set(branchHost, input.runtime)
  return branchHost
}

/**
 * A branch production runs: the project's own `sixb dev --from production` runtime, as a laptop
 * runs it, behind a front that answers on one port whatever state the project is in, and only to
 * requests that carry the branch's key. Production delivers its copy where a laptop spools one
 * (`.sixb/branches`), and the rest in its environment, never on its command line.
 */

/** The key the runtime's front asks every request for. */
export const BRANCH_KEY_ENV = "SIXB_BRANCH_KEY"

/**
 * The port the runtime's front listens on, in the sandbox. The API listens on the next port and
 * the project's app on the one after, both only where the front reaches them.
 */
export const BRANCH_PORT_ENV = "SIXB_BRANCH_PORT"

/** Where the front is reached from outside the sandbox: the app sends its API requests there. */
export const BRANCH_PUBLIC_ORIGIN_ENV = "SIXB_BRANCH_PUBLIC_ORIGIN"

/** Production's app, when the deployment says where: the branch's banner links back to it. */
export const BRANCH_PRODUCTION_ORIGIN_ENV = "SIXB_BRANCH_PRODUCTION_ORIGIN"

/**
 * Paths the front sends to the API; everything else goes to the project's app, the app's own
 * `/__sixb/assets/*` and `/__sixb/dev-reload.js` included. The front answers
 * {@link BRANCH_STATUS_PATH} itself.
 */
export function isBranchApiPath(pathname: string): boolean {
  return (
    BRANCH_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    BRANCH_API_PATHS.includes(pathname)
  )
}

const BRANCH_API_PREFIXES = ["/api/", "/auth/", "/ws/", "/docs/"]
const BRANCH_API_PATHS = ["/api", "/docs", "/health", "/ready"]

/** The branch's schema on production's instance, as the role limited to it. */
export const BRANCH_DATABASE_URL_ENV = "SIXB_BRANCH_DATABASE_URL"
export const BRANCH_DATABASE_SCHEMA_ENV = "SIXB_BRANCH_DATABASE_SCHEMA"

/** Where a project keeps its branches' copies, as `sixb dev --from production` does. */
export const BRANCH_COPIES_DIRECTORY = ".sixb/branches"

/** The name a hosted branch's copy goes by there: `hosted.copy`, then its record in the index. */
export const HOSTED_BRANCH_COPY = "hosted"

/** The header production sends the key in. */
export const BRANCH_KEY_HEADER = "x-sixb-branch-key"

/** Where the front answers with {@link BranchRuntimeStatus}. */
export const BRANCH_STATUS_PATH = "/__sixb/branch"

/** The copy a branch's runtime loaded: what production's row says the branch runs on. */
export interface BranchLoadedCopy {
  readonly takenAt: string
  readonly objects: number
  /** Types left out: unreadable in production, or no longer fitting the branch's definitions. */
  readonly skipped: BranchData["skipped"]
  /** Types its creator reads only in part: the branch's migrations ran on the rest. */
  readonly partial: BranchData["partial"]
  /** What a deploy of the branch's code would refuse in what the copy held. */
  readonly refusedByDeploy: BranchData["refusedByDeploy"]
  /** What a deploy would check that the copy can't. */
  readonly unchecked: BranchData["unchecked"]
  /** The branch's migrations the copy ran, by type. */
  readonly migrated: BranchData["migrated"]
  /** Datasets its lake slice left out: their creator may not read every column. */
  readonly skippedDatasets: BranchData["skippedDatasets"]
  readonly lakeSliceId: string | null
}

/** What a branch's runtime serves right now: the generation its front last started. */
export interface BranchRuntimeStatus {
  readonly branch: string
  /** Counts restarts: every change that reaches the checkout starts a new generation. */
  readonly generation: number
  readonly state: Extract<BranchState, "starting" | "ready" | "failed">
  /** The checkout's commit when the generation started. */
  readonly commit: string | null
  readonly error: BranchError | null
  /** Requests the front forwarded since it started: production's own status reads not counted. */
  readonly requests: number
  /** The copy the runtime loaded, once it has: null before. */
  readonly copy: BranchLoadedCopy | null
}

/**
 * Starts the project's own `sixb dev` as the branch's runtime, from the project's folder, its own
 * `sixb` first on the PATH, then the Bun its checkout installed, if any, its log in
 * `.sixb/branch.log`.
 */
export const BRANCH_RUNTIME_COMMAND = [
  "mkdir -p .sixb",
  'root="$(git rev-parse --show-toplevel)"',
  `PATH="$PWD/node_modules/.bin:$root/node_modules/.bin:${BRANCH_TOOLS_PATH}:$PATH"`,
  `exec sixb dev --port "$${BRANCH_PORT_ENV}" --host 0.0.0.0 >> .sixb/branch.log 2>&1`,
].join("; ")

/** Reads a front's answer, or null when it isn't one. */
export function parseBranchRuntimeStatus(value: unknown): BranchRuntimeStatus | null {
  if (typeof value !== "object" || value === null) return null

  const status = value as Record<string, unknown>
  if (status.state !== "starting" && status.state !== "ready" && status.state !== "failed") {
    return null
  }

  const error = status.error as Record<string, unknown> | null
  return {
    branch: String(status.branch),
    generation: Number(status.generation),
    requests: typeof status.requests === "number" ? status.requests : 0,
    state: status.state,
    commit: typeof status.commit === "string" ? status.commit : null,
    error:
      error && typeof error.message === "string"
        ? {
            message: error.message,
            ...(typeof error.file === "string" ? { file: error.file } : {}),
          }
        : null,
    copy: parseLoadedCopy(status.copy),
  }
}

/** A loaded copy, as an index record or a front's status carries it, or null. */
export function parseLoadedCopy(value: unknown): BranchLoadedCopy | null {
  if (typeof value !== "object" || value === null) return null
  const copy = value as Record<string, unknown>
  if (typeof copy.takenAt !== "string" || typeof copy.objects !== "number") return null

  const skippedDatasets = Array.isArray(copy.skippedDatasets) ? copy.skippedDatasets : []
  return {
    takenAt: copy.takenAt,
    objects: copy.objects,
    ...parseCopyTypes(copy),
    skippedDatasets: skippedDatasets.map((entry) => {
      const skip = (entry ?? {}) as Record<string, unknown>
      return {
        datasetId: String(skip.datasetId),
        reason: "missing_clearance" as const,
        columns: Array.isArray(skip.columns) ? skip.columns.map(String) : [],
      }
    }),
    lakeSliceId: typeof copy.lakeSliceId === "string" ? copy.lakeSliceId : null,
  }
}
