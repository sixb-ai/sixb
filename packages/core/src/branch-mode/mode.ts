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
}

/** The branch's name. The host sets it, as it sets `NODE_ENV`; a project never does. */
export const BRANCH_NAME_ENV = "SIXB_BRANCH"

/** Where the branch's data comes from. Set with `SIXB_BRANCH`, never alone. */
export const BRANCH_DATA_FROM_ENV = "SIXB_BRANCH_DATA_FROM"

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

  if (name === undefined && dataFrom === undefined) return null

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

  return Object.freeze({ name, dataFrom })
}

/**
 * The project id the branch's broker streams and queue lanes go by, so that nothing it publishes
 * or enqueues reaches a consumer of production, or of another branch, on shared infrastructure.
 *
 * It keeps to `[a-zA-Z0-9_-]`, which every provider accepts. A git branch name may hold `/` or `.`,
 * so the readable part is a slug, and the hash of the exact name keeps `feature/a` and `feature-a`
 * apart.
 */
export function branchTransportId(projectId: string, branch: SixbBranch): string {
  const slug = branch.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  const hash = createHash("sha256").update(branch.name).digest("hex").slice(0, 8)

  return `${projectId}--branch-${slug}-${hash}`
}
