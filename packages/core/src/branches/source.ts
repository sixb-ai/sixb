import { isPlainRecord } from "../json"
import { RuntimeError } from "../runtime/errors"
import type { SandboxEnvironment } from "../sandboxes/configuration"

/** Where the project's own code lives, so production can run one of its git branches. */
export interface ProjectSource {
  /**
   * The git repository: a GitHub repository written `owner/name`, or any URL git clones, such as
   * `https://git.example.com/acme/operations.git` or a path on this machine.
   */
  readonly repository: string
  /** The project's folder inside the repository, where `sixb.config.ts` is. Defaults to `.`. */
  readonly path?: string
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/** A frozen copy, or a clear error naming what to fix. */
export function captureProjectSource(source: unknown): ProjectSource {
  if (
    !isPlainRecord(source) ||
    Object.keys(source).some((key) => !["repository", "path"].includes(key))
  ) {
    throw new RuntimeError(
      "[Sixb] source takes a repository, such as `acme/operations`, and an optional path."
    )
  }

  const { repository, path } = source
  if (typeof repository !== "string" || repository.trim() === "") {
    throw new RuntimeError(
      "[Sixb] source.repository must name the project's git repository, such as `acme/operations`."
    )
  }
  if (path !== undefined && !isProjectPath(path)) {
    throw new RuntimeError(
      "[Sixb] source.path must be the project's folder relative to the repository root, such as `apps/operations`."
    )
  }

  return Object.freeze({
    repository,
    ...(path === undefined || path === "." ? {} : { path: path.replace(/\/+$/, "") }),
  })
}

/** The URL git clones for the source. */
export function sourceGitUrl(source: ProjectSource): string {
  return GITHUB_REPOSITORY.test(source.repository)
    ? `https://github.com/${source.repository}.git`
    : source.repository
}

/** The files a push changes the installed dependencies with. */
export const BRANCH_DEPENDENCY_FILES: readonly string[] = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]

/**
 * Names git and a shell both take as one word: a branch name reaches the sandbox's setup command,
 * so anything outside this set is refused rather than quoted.
 */
export function assertGitBranchName(branch: unknown): asserts branch is string {
  if (
    typeof branch !== "string" ||
    branch.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    /^[-/.]|[/.]$|\.\.|\/\/|\.lock$|\/\./.test(branch)
  ) {
    throw new RuntimeError(
      "[Sixb] A branch is a git branch name of letters, digits, '.', '_', '-' and '/', such as `feature/invoices`."
    )
  }
}

/**
 * A fresh checkout of `branch` in the sandbox's working directory, with the repository's
 * dependencies installed. The clone is a setup command rather than a sandbox `source`, so any URL
 * git takes works, a path on this machine included; HTTPS credentials still come from the
 * session's request credentials, outside the guest. The project's sandbox recipe sets the network
 * and adds its variables.
 */
export function branchCheckout(input: {
  readonly source: ProjectSource
  readonly branch: string
}): Pick<SandboxEnvironment, "setup"> {
  const { source, branch } = input
  assertGitBranchName(branch)

  const url = sourceGitUrl(source)
  if (url.includes("'") || url.startsWith("-")) {
    throw new RuntimeError(`[Sixb] source.repository '${url}' cannot be cloned: it holds a quote.`)
  }

  return {
    setup: [
      `git clone --quiet -- '${url}' . && git checkout --quiet '${branch}'`,
      BRANCH_INSTALL_COMMAND,
    ],
  }
}

/**
 * Installs JavaScript dependencies when the repository has a root manifest, and nothing else: at
 * checkout, and again when a push changes the manifest or a lockfile.
 */
export const BRANCH_INSTALL_COMMAND = [
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
