import { isPlainRecord } from "../json"
import { param } from "../shared/params/builders"
import type { SandboxEnvironment } from "./configuration"
import { SandboxError } from "./errors"

/** Where the project's own code lives, so a thread can work on one of its branches. */
export interface ProjectSource {
  /** The GitHub repository, `owner/name`. */
  readonly repository: string
  /** The project's folder inside the repository. Defaults to its root, `.`. */
  readonly path?: string
  /**
   * The secret of the repository's push webhook, pointed at `/api/source/github`: a branch's
   * runtime then pulls as soon as it's pushed to, rather than at its next look.
   */
  readonly webhookSecret?: string
}

/** What a thread on a branch of the project names, and all it names. */
export const PROJECT_SOURCE_PARAMS = {
  branch: param("string", {
    required: true,
    description: "The branch of the project's repository to work on, created when it is new.",
  }),
}

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/** A frozen copy, or a clear error naming what to fix. */
export function captureProjectSource(source: unknown): ProjectSource {
  if (
    !isPlainRecord(source) ||
    Object.keys(source).some((key) => !["repository", "path", "webhookSecret"].includes(key))
  ) {
    throw new SandboxError(
      "[Sixb] source takes a repository, `owner/name`, an optional path and an optional webhookSecret."
    )
  }
  const { repository, path, webhookSecret } = source
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) {
    throw new SandboxError(
      "[Sixb] source.repository must be a GitHub repository written `owner/name`, such as `acme/operations`."
    )
  }
  if (path !== undefined && !isProjectPath(path)) {
    throw new SandboxError(
      "[Sixb] source.path must be the project's folder relative to the repository root, such as `apps/operations`."
    )
  }
  if (webhookSecret !== undefined && (typeof webhookSecret !== "string" || webhookSecret === "")) {
    throw new SandboxError("[Sixb] source.webhookSecret must be the push webhook's secret.")
  }
  return Object.freeze({
    repository,
    ...(path === undefined || path === "." ? {} : { path: path.replace(/\/+$/, "") }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  })
}

/** A thread that names only `branch` works on the project's own repository. */
export function isProjectBranchBinding(input: unknown): input is { readonly branch: unknown } {
  return isPlainRecord(input) && Object.keys(input).length === 1 && "branch" in input
}

/**
 * The names git and a shell both take as one word: a branch name reaches the sandbox's setup
 * command, so anything outside this set is refused rather than quoted.
 */
export function assertBranchName(branch: unknown): asserts branch is string {
  if (
    typeof branch !== "string" ||
    branch.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    /^[-/.]|[/.]$|\.\.|\/\/|\.lock$|\/\./.test(branch)
  ) {
    throw new SandboxError(
      "[Sixb] branch must be a git branch name of letters, digits, '.', '_', '-' and '/', such as `vendor-invoices`."
    )
  }
}

/**
 * A fresh checkout of `branch`, created from the default branch when it does not exist yet, with
 * the repository's dependencies installed. The project's static recipe still sets the network and
 * adds its variables.
 */
export function projectSourceEnvironment(input: {
  readonly source: ProjectSource
  readonly branch: unknown
  readonly access: "read" | "write"
  readonly base: SandboxEnvironment
}): SandboxEnvironment {
  const { source, branch, access, base } = input
  assertBranchName(branch)
  return {
    source: { type: "git", url: `https://github.com/${source.repository}.git`, access },
    setup: [`git checkout '${branch}' 2>/dev/null || git checkout -b '${branch}'`, INSTALL],
    // Setup and the agent install packages and run the project's tools; credentials stay outside.
    network: base.network ?? { mode: "all" },
    env: {
      ...base.env,
      SIXB_SOURCE_REPOSITORY: source.repository,
      SIXB_SOURCE_BRANCH: branch,
      SIXB_SOURCE_PATH: source.path ?? ".",
    },
  }
}

/** Installs JavaScript dependencies when the repository has a root manifest, and nothing else. */
const INSTALL = [
  "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile || bun install",
  "elif [ -f package-lock.json ]; then npm ci || npm install",
  "elif [ -f pnpm-lock.yaml ]; then COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile",
  "elif [ -f yarn.lock ]; then yarn install --frozen-lockfile || yarn install",
  "elif [ -f package.json ]; then bun install",
  "fi",
].join("; ")

function isProjectPath(path: unknown): path is string {
  if (typeof path !== "string") return false
  if (path === ".") return true
  const segments = path.replace(/\/+$/, "").split("/")
  return segments.every(
    (segment) => PATH_SEGMENT.test(segment) && segment !== "." && segment !== ".."
  )
}
