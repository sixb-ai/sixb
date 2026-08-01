/**
 * Vercel's Ignored Build Step for the docs site: exit 0 to skip the build, non-zero to run it.
 *
 * The rule this replaces diffed `HEAD^ HEAD` against `apps/docs` and `packages/ui`, but the site
 * renders `/docs` at the repo root (`apps/docs/src/docs/config.ts`). Every documentation-only
 * commit therefore skipped its own deployment, and nothing ever caught up: twelve of the last three
 * hundred commits edited a published page that never shipped.
 *
 * Two properties keep that from happening again.
 *
 * **Prove, or build.** Vercel clones at `--depth=10` with no remote configured, so the previously
 * deployed commit is regularly missing and no fetch can bring it back. Anything that cannot be
 * proven untouched is built. A wasted build shows up on an invoice; a stale site shows up nowhere.
 *
 * **One declaration, one test.** `WATCHED_PATHS` is the only place the paths are written, and
 * `scripts/tests/docs-vercel-ignore.test.ts` fails when the site grows a content root or a
 * workspace dependency outside them.
 *
 * `VERCEL_GIT_PREVIOUS_SHA` is the last *successfully deployed* commit for this project and branch,
 * so the diff spans the whole gap since the last build rather than a single push.
 */

const LOG_PREFIX = "[SixbDocs]"

/**
 * Everything the rendered site is built from. `:/` anchors a pathspec to the repo root, so the list
 * means the same thing whichever directory Vercel runs the ignore step from.
 */
export const WATCHED_PATHS = [
  ":/docs", // the content — read from the repo root by apps/docs/src/docs/config.ts
  ":/apps/docs", // the site that renders it
  ":/packages/ui", // its only workspace dependency
  ":/bun.lock", // a next, shiki, or tailwind bump changes the rendered output
] as const

export interface IgnoreDecision {
  readonly build: boolean
  readonly reason: string
}

export interface GitProbe {
  /** Whether `sha` resolves to a commit present in this shallow clone. */
  readonly hasCommit: (sha: string) => boolean
  /** Watched paths touched in `range`, or `null` when git could not answer. */
  readonly changedPaths: (range: string, pathspecs: readonly string[]) => readonly string[] | null
}

export function decideDocsBuild(input: {
  readonly previousSha: string | undefined
  readonly git: GitProbe
}): IgnoreDecision {
  const previousSha = input.previousSha?.trim()
  if (!previousSha) {
    return { build: true, reason: "no previous successful deployment for this branch" }
  }

  if (!input.git.hasCommit(previousSha)) {
    return { build: true, reason: `${abbreviate(previousSha)} is outside the shallow clone` }
  }

  const changed = input.git.changedPaths(`${previousSha}..HEAD`, WATCHED_PATHS)
  if (changed === null) {
    return { build: true, reason: `git could not diff ${abbreviate(previousSha)}..HEAD` }
  }
  if (changed.length > 0) {
    return { build: true, reason: `${summarize(changed)} since ${abbreviate(previousSha)}` }
  }

  return { build: false, reason: `no watched path changed since ${abbreviate(previousSha)}` }
}

export function gitProbe(cwd: string): GitProbe {
  return {
    hasCommit: (sha) => git(cwd, ["cat-file", "-e", `${sha}^{commit}`]) !== null,
    changedPaths: (range, pathspecs) => {
      const output = git(cwd, ["diff", "--name-only", range, "--", ...pathspecs])
      return output === null ? null : output.split("\n").filter((line) => line.length > 0)
    },
  }
}

/** Trimmed stdout, or `null` when git exited non-zero — which every caller reads as "cannot prove". */
function git(cwd: string, args: readonly string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  return result.success ? result.stdout.toString().trim() : null
}

function summarize(changed: readonly string[]): string {
  const [first, ...rest] = changed
  return rest.length === 0 ? `${first} changed` : `${first} and ${rest.length} more changed`
}

function abbreviate(sha: string): string {
  return sha.slice(0, 8)
}

if (import.meta.main) {
  const decision = decideDocsBuild({
    previousSha: process.env.VERCEL_GIT_PREVIOUS_SHA,
    git: gitProbe(process.cwd()),
  })

  // The skip is the dangerous outcome, so it says why, from where, out loud.
  console.log(
    `${LOG_PREFIX} ${decision.build ? "build" : "skip"}: ${decision.reason} (in ${process.cwd()})`
  )
  process.exitCode = decision.build ? 1 : 0
}
