import { isPlainRecord } from "../json"
import { RuntimeError } from "../runtime/errors"
import { capturePreviewDomain } from "./preview"

/** Where the project's own code lives, so production can run one of its git branches. */
export interface ProjectSource {
  /**
   * The git repository: a GitHub repository written `owner/name`, or any URL git clones, such as
   * `https://git.example.com/acme/operations.git` or a path on this machine.
   */
  readonly repository: string
  /** The project's folder inside the repository, where `sixb.config.ts` is. Defaults to `.`. */
  readonly path?: string
  /**
   * Where people open the branches production runs: each at `<branch>.<previewDomain>`, which
   * production's server forwards to the branch. A domain of its own, outside production's
   * `cookieDomain`, as Vercel uses vercel.app. Without it, a branch is opened at its sandbox's URL.
   */
  readonly previewDomain?: string
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * A frozen copy, or a clear error naming what to fix. `cookieDomain` is production's, which a
 * preview domain must stay out of.
 */
export function captureProjectSource(source: unknown, cookieDomain?: string): ProjectSource {
  if (
    !isPlainRecord(source) ||
    Object.keys(source).some((key) => !["repository", "path", "previewDomain"].includes(key))
  ) {
    throw new RuntimeError(
      "[Sixb] source takes a repository, such as `acme/operations`, an optional path and an optional previewDomain."
    )
  }

  const { repository, path, previewDomain } = source
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
    ...(previewDomain === undefined
      ? {}
      : { previewDomain: capturePreviewDomain(previewDomain, cookieDomain) }),
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

/** One step of a branch's checkout: a shell script, run in the sandbox's working directory. */
export interface BranchCheckoutStep {
  /** What it does, as a failure names it: "clone the branch". */
  readonly name: string
  readonly script: string
}

/**
 * Where a checkout that finished leaves its mark, inside `.git` so no status shows it: a saved
 * sandbox without it never finished its first checkout, and is made anew.
 */
export const BRANCH_CHECKOUT_MARK = ".git/sixb-checkout-done"

/**
 * A fresh checkout of `branch` in the sandbox's working directory, with Bun where the image has
 * none and the repository's dependencies installed, then the mark that it finished. The worker
 * runs each step as its own command, so a slow or failed one says which it was, in its own
 * words. Any URL git takes works, a path on this machine included; HTTPS credentials come from
 * the session's request credentials, outside the guest.
 */
export function branchCheckout(input: {
  readonly source: ProjectSource
  readonly branch: string
}): readonly BranchCheckoutStep[] {
  const { source, branch } = input
  assertGitBranchName(branch)

  const url = sourceGitUrl(source)
  if (url.includes("'") || url.startsWith("-")) {
    throw new RuntimeError(`[Sixb] source.repository '${url}' cannot be cloned: it holds a quote.`)
  }

  return [
    { name: "install Bun", script: BRANCH_BUN_COMMAND },
    {
      name: "clone the branch",
      script: `git clone --quiet -- '${url}' . && git checkout --quiet '${branch}'`,
    },
    { name: "install the branch's dependencies", script: BRANCH_INSTALL_COMMAND },
    { name: "finish the checkout", script: `touch ${BRANCH_CHECKOUT_MARK}` },
  ]
}

/**
 * The Bun a branch's sandbox installs when its image has none, or one older than Sixb's packages
 * take, as Vercel's stock runtime has only Node: the one this repository builds with
 * (`.bun-version`).
 */
export const BRANCH_BUN_VERSION = "1.4.4"

/** The oldest Bun Sixb's packages run on (their `engines.bun`). */
export const BRANCH_BUN_MINIMUM = "1.4.2"

/**
 * Where that Bun is, outside the checkout. A branch's commands look there first: it is there
 * only when the image's own Bun was missing or too old.
 */
export const BRANCH_TOOLS_PATH = "$HOME/.sixb-branch/node_modules/.bin"

/**
 * Installs Bun from the npm registry, which a branch already reaches, unless the image has a
 * recent enough one. The `bun` package carries each platform's binary in a package of its own;
 * npm checks each against the sha512 the registry gives for it.
 */
export const BRANCH_BUN_COMMAND = [
  `export PATH="${BRANCH_TOOLS_PATH}:$PATH"`,
  `if command -v bun >/dev/null 2>&1 && bun -e 'process.exit(Bun.semver.satisfies(Bun.version, ">=${BRANCH_BUN_MINIMUM}") ? 0 : 1)' >/dev/null 2>&1; then exit 0; fi`,
  'if ! command -v npm >/dev/null 2>&1; then echo "The sandbox has neither Bun nor npm: boot it from an image with Bun." >&2; exit 1; fi',
  `npm install --prefix "$HOME/.sixb-branch" --no-audit --no-fund --loglevel=error bun@${BRANCH_BUN_VERSION}`,
  // The shell remembers where it found `bun` before the install.
  "hash -r",
  "bun --version >/dev/null",
].join("; ")

/**
 * Installs JavaScript dependencies when the repository has a root manifest, and nothing else: at
 * checkout, and again when a push changes the manifest or a lockfile.
 */
export const BRANCH_INSTALL_COMMAND = [
  `export PATH="${BRANCH_TOOLS_PATH}:$PATH"`,
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
