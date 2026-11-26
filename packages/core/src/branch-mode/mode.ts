import { createHash } from "node:crypto"
import { RuntimeError } from "../runtime/errors"

/**
 * The branch a runtime runs as, when it runs as one: the git branch's code on a copy of what its
 * creator reads in production. `null` everywhere else, production and plain `sixb dev` included.
 */
export interface SixbBranch {
  /** The git branch's name, such as `"feature/invoices"`. */
  readonly name: string
  /** Where the branch's data was copied from. */
  readonly dataFrom: "production"
  /**
   * Who runs it, when the same git branch can run in more than one place on shared
   * infrastructure: a checkout on a laptop, a hosted branch. Absent for a host that sets none.
   */
  readonly runtime?: string
}

/** The branch's name. The host sets it, as it sets `NODE_ENV`; a project never does. */
export const BRANCH_NAME_ENV = "SIXB_BRANCH"

/** Where the branch's data comes from. Set with `SIXB_BRANCH`, never alone. */
export const BRANCH_DATA_FROM_ENV = "SIXB_BRANCH_DATA_FROM"

/** Who runs the branch, such as a checkout's id. Optional, and only with `SIXB_BRANCH`. */
export const BRANCH_RUNTIME_ENV = "SIXB_BRANCH_RUNTIME"

const RUNTIME_ID = /^[A-Za-z0-9_-]{1,64}$/

const MAX_BRANCH_NAME_LENGTH = 255

// Whitespace and control characters: what git refuses in a branch name, and what would make a
// broker subject or a log line ambiguous.
const INVALID_BRANCH_NAME = /[\s\u0000-\u001f\u007f]/

/**
 * Read the branch the host says this process runs as.
 *
 * Both variables are set together, by `sixb dev --from production`, or neither is. A branch never
 * runs with `NODE_ENV=production`: production is not a branch, and a deployment that inherited
 * the variables by mistake must stop here rather than start with its gates on.
 */
export function resolveBranchMode(
  env: Readonly<Record<string, string | undefined>>
): SixbBranch | null {
  const name = env[BRANCH_NAME_ENV]
  const dataFrom = env[BRANCH_DATA_FROM_ENV]
  const runtime = env[BRANCH_RUNTIME_ENV]

  if (name === undefined && dataFrom === undefined) {
    if (runtime === undefined) return null
    throw new RuntimeError(
      `[Sixb] ${BRANCH_RUNTIME_ENV} says who runs a branch, and is set only with ${BRANCH_NAME_ENV}. Unset it.`
    )
  }

  if (name === undefined || dataFrom === undefined) {
    const found = name === undefined ? BRANCH_DATA_FROM_ENV : BRANCH_NAME_ENV
    throw new RuntimeError(
      `[Sixb] ${BRANCH_NAME_ENV} and ${BRANCH_DATA_FROM_ENV} are set together, by ` +
        `\`sixb dev --from production\`, but only ${found} is set. Unset it, or start the branch ` +
        "with `sixb dev --from production`."
    )
  }

  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH || INVALID_BRANCH_NAME.test(name)) {
    throw new RuntimeError(
      `[Sixb] ${BRANCH_NAME_ENV} must be a git branch name: 1 to ${MAX_BRANCH_NAME_LENGTH} ` +
        `characters, without spaces or control characters. Received ${JSON.stringify(name)}.`
    )
  }

  if (dataFrom !== "production") {
    throw new RuntimeError(
      `[Sixb] Branch "${name}": ${BRANCH_DATA_FROM_ENV} must be "production", the only place a ` +
        `branch copies its data from. Received ${JSON.stringify(dataFrom)}.`
    )
  }

  if (env.NODE_ENV === "production") {
    throw new RuntimeError(
      `[Sixb] Branch "${name}" cannot run with NODE_ENV=production: production never runs as a ` +
        `branch. Remove ${BRANCH_NAME_ENV} and ${BRANCH_DATA_FROM_ENV} from production's ` +
        "environment, or run the branch with `sixb dev --from production`."
    )
  }

  if (runtime !== undefined && !RUNTIME_ID.test(runtime)) {
    throw new RuntimeError(
      `[Sixb] Branch "${name}": ${BRANCH_RUNTIME_ENV} must be 1 to 64 letters, digits, \`-\` or \`_\`. ` +
        `Received ${JSON.stringify(runtime)}.`
    )
  }

  return Object.freeze({ name, dataFrom, ...(runtime === undefined ? {} : { runtime }) })
}

/**
 * The variables as they were when core was first evaluated. Core is imported before the body of
 * `sixb.config.ts` runs, so nothing the project's code does to `process.env` changes the branch a
 * host runs as. Only the raw values are kept: they are validated when a host is built, so a wrong
 * one fails the host, not every import of core.
 */
const HOST_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  [BRANCH_NAME_ENV]: process.env[BRANCH_NAME_ENV],
  [BRANCH_DATA_FROM_ENV]: process.env[BRANCH_DATA_FROM_ENV],
  [BRANCH_RUNTIME_ENV]: process.env[BRANCH_RUNTIME_ENV],
  NODE_ENV: process.env.NODE_ENV,
})

const placedOnBranch = new WeakMap<object, SixbBranch>()

/**
 * Put the host these options build on a branch, as the environment would. For this repo's tests,
 * which cannot set the variables before core loads. It can only add a branch: a host the
 * environment put on one stays on it.
 */
export function putOnBranch<T extends object>(options: T, branch: SixbBranch): T {
  placedOnBranch.set(options, branch)
  return options
}

/**
 * The branch a host built from `options` runs as. `NODE_ENV=production` is refused whether it was
 * set before core loaded or after, as the production commands of the CLI set it.
 */
export function resolveHostBranch(options: object): SixbBranch | null {
  const nodeEnv = process.env.NODE_ENV === "production" ? "production" : HOST_ENV.NODE_ENV
  const fromEnv = resolveBranchMode({ ...HOST_ENV, NODE_ENV: nodeEnv })

  const placed = placedOnBranch.get(options)
  if (!placed) return fromEnv

  const branch = resolveBranchMode({
    [BRANCH_NAME_ENV]: placed.name,
    [BRANCH_DATA_FROM_ENV]: placed.dataFrom,
    [BRANCH_RUNTIME_ENV]: placed.runtime,
    NODE_ENV: nodeEnv,
  })
  if (fromEnv && fromEnv.name !== branch?.name) {
    throw new RuntimeError(
      `[Sixb] Branch "${fromEnv.name}": this host runs as that branch and cannot be put on ` +
        `branch "${placed.name}".`
    )
  }

  return fromEnv ?? branch
}

/**
 * The project id the branch's broker streams and queue lanes go by, so that nothing it publishes
 * or enqueues reaches a consumer of production, or of another branch, on shared infrastructure.
 *
 * It keeps to `[a-zA-Z0-9_-]`, which every provider accepts. A git branch name may hold `/` or `.`,
 * so the readable part is a slug, and the hash of the exact name keeps `feature/a` and `feature-a`
 * apart. The hash covers who runs it too: a laptop's `feature/a` and a hosted one never share a
 * job on a dev broker both reach.
 */
export function branchTransportId(projectId: string, branch: SixbBranch): string {
  const slug = branch.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const identity = branch.runtime === undefined ? branch.name : `${branch.name}\0${branch.runtime}`
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8)

  return `${projectId}--branch-${slug}-${hash}`
}
