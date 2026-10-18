import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { docsConfig } from "../../apps/docs/src/docs/config"
import { decideDocsBuild, type GitProbe, WATCHED_PATHS } from "../docs-vercel-ignore"
import {
  type DependencyField,
  internalDependencies,
  type PackageJson,
} from "../publishable-packages"

/**
 * Every field a build reads, `devDependencies` included — `shiki` and `tailwindcss` are declared
 * there and are as load-bearing to the rendered page as anything the site ships.
 */
const BUILD_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly DependencyField[]

/**
 * A skipped deployment is invisible: the site keeps serving, the commit is green, and the page
 * nobody can read looks published. So the decision is tested for the two ways it can be wrong —
 * skipping something it should have built, and reading a path list that has drifted from what the
 * site is actually made of.
 */

const repoRoot = resolve(import.meta.dir, "..", "..")

/** Repo-relative directories, with the `:/` pathspec anchor stripped. */
const watchedDirs = WATCHED_PATHS.map((pathspec) => pathspec.slice(2))

function isWatched(repoRelativePath: string): boolean {
  return watchedDirs.some(
    (dir) => repoRelativePath === dir || repoRelativePath.startsWith(`${dir}/`)
  )
}

function probe(overrides: Partial<GitProbe> = {}): GitProbe {
  return { hasCommit: () => true, changedPaths: () => [], ...overrides }
}

describe("decideDocsBuild", () => {
  const deployedSha = "0f1e2d3c4b5a69788796a5b4c3d2e1f009876543"

  test.each([
    {
      name: "builds when the branch has no previous deployment to compare against",
      previousSha: undefined,
      git: probe(),
      build: true,
      reason: "no previous successful deployment for this branch",
    },
    {
      name: "builds when the previous commit fell out of the shallow clone",
      previousSha: deployedSha,
      git: probe({ hasCommit: () => false }),
      build: true,
      reason: "outside the shallow clone",
    },
    {
      name: "builds when git cannot answer at all",
      previousSha: deployedSha,
      git: probe({ changedPaths: () => null }),
      build: true,
      reason: "could not diff",
    },
    {
      name: "builds when a watched path changed, and names the file that caused it",
      previousSha: deployedSha,
      git: probe({ changedPaths: () => ["docs/deployment/overview.md"] }),
      build: true,
      reason: "docs/deployment/overview.md",
    },
    {
      name: "skips only when nothing watched changed",
      previousSha: deployedSha,
      git: probe(),
      build: false,
      reason: "no watched path changed",
    },
  ])("$name", ({ previousSha, git, build, reason }) => {
    const decision = decideDocsBuild({ previousSha, git })

    expect(decision.build).toBe(build)
    expect(decision.reason).toContain(reason)
  })

  test("asks git about every watched path", () => {
    let asked: readonly string[] = []
    decideDocsBuild({
      previousSha: deployedSha,
      git: probe({
        changedPaths: (_range, pathspecs) => {
          asked = pathspecs
          return []
        },
      }),
    })

    expect(asked).toEqual(WATCHED_PATHS)
  })
})

/**
 * The step as Vercel runs it: a process in the site's directory whose exit code is the decision.
 * The repository's history is base → a docs edit → a README edit.
 */
describe("the ignored build step", () => {
  const ignoreStep = join(import.meta.dir, "..", "docs-vercel-ignore.ts")
  let repo = ""
  const commits = { base: "", docsEdit: "" }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "sixb-docs-ignore-"))
    // Async and bounded: a synchronous spawn can hang a parallel test worker on a reaped child.
    const git = async (...args: string[]) => {
      const result = await run(
        [
          "git",
          // A contributor who signs every commit globally would otherwise get `gpg: no secret key`
          // out of a test about pathspecs, since nothing here has a key for `test@sixb.local`.
          ...["-c", "user.email=test@sixb.local", "-c", "user.name=Sixb Test"],
          ...["-c", "commit.gpgsign=false", ...args],
        ],
        repo
      )
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`)
      return result.stdout.trim()
    }

    await mkdir(join(repo, "apps", "docs"), { recursive: true })
    await mkdir(join(repo, "docs"), { recursive: true })
    await writeFile(join(repo, "docs", "overview.md"), "# one\n")
    await writeFile(join(repo, "apps", "docs", "page.tsx"), "export default null\n")
    await writeFile(join(repo, "README.md"), "# repo\n")
    await git("init", "-q")
    await git("add", "-A")
    await git("commit", "-q", "-m", "initial")
    commits.base = await git("rev-parse", "HEAD")

    await writeFile(join(repo, "docs", "overview.md"), "# two\n")
    await git("commit", "-q", "-am", "docs: edit a page")
    commits.docsEdit = await git("rev-parse", "HEAD")

    await writeFile(join(repo, "README.md"), "# changed\n")
    await git("commit", "-q", "-am", "readme: edit")
  })

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  // Vercel runs the step from the project's root directory, not the repo's. The `:/` anchor is
  // what makes that irrelevant, and it is the assumption the old rule silently depended on.
  const runStep = (previousSha: string) =>
    run([process.execPath, ignoreStep], join(repo, "apps", "docs"), {
      VERCEL_GIT_PREVIOUS_SHA: previousSha,
    })

  test.concurrent("builds for a watched change anywhere since the last deployment", async () => {
    // The docs edit is one commit behind HEAD: diffing only the last commit would skip it.
    const result = await runStep(commits.base)

    expect(result.stdout).toContain("build: docs/overview.md changed")
    expect(result.exitCode).toBe(1)
  })

  test.concurrent("skips when only unwatched paths changed", async () => {
    const result = await runStep(commits.docsEdit)

    expect(result.stdout).toContain("skip: no watched path changed")
    expect(result.exitCode).toBe(0)
  })

  test.concurrent("builds when the last deployment is missing from the clone", async () => {
    const result = await runStep("0f1e2d3c4b5a69788796a5b4c3d2e1f009876543")

    expect(result.stdout).toContain("build: 0f1e2d3c is outside the shallow clone")
    expect(result.exitCode).toBe(1)
  })
})

describe("the watched paths cover what the site is built from", () => {
  test("every rendered page lives under a watched path", () => {
    expect(docsConfig.length).toBeGreaterThan(20)

    const unwatched = docsConfig
      .map((doc) => relative(repoRoot, doc.sourcePath))
      .filter((path) => !isWatched(path))

    expect({ unwatched }).toEqual({ unwatched: [] })
  })

  test("every workspace package the site is built from lives under a watched path", () => {
    // Removal proof: remove core/client/google/rest from WATCHED_PATHS; the site's
    // current workspace dependency graph exposes all four missing deployment triggers.
    const dependencies = transitiveWorkspaceDependencies("apps/docs")
    expect(dependencies.length).toBeGreaterThan(0)

    expect({ unwatched: dependencies.filter((dir) => !isWatched(dir)) }).toEqual({ unwatched: [] })
  })
})

/** Repo-relative directories of the workspace packages `startDir` depends on, transitively. */
function transitiveWorkspaceDependencies(startDir: string): string[] {
  const byName = workspacePackages()
  const found = new Set<string>()
  const queue = [startDir]

  while (queue.length > 0) {
    const dir = queue.pop()
    if (dir === undefined) continue

    for (const name of internalDependencies(readManifest(dir), BUILD_DEPENDENCY_FIELDS)) {
      const dependencyDir = byName.get(name)
      if (dependencyDir === undefined || found.has(dependencyDir)) continue
      found.add(dependencyDir)
      queue.push(dependencyDir)
    }
  }

  return [...found]
}

/**
 * Every workspace package by name, including the private ones. `discoverPublishablePackages` skips
 * those, and a private dependency is exactly the kind that would slip past this guard.
 */
function workspacePackages(): Map<string, string> {
  const { workspaces = [] } = readManifest<{ workspaces?: string[] }>(".")
  const byName = new Map<string, string>()

  for (const pattern of workspaces) {
    const parent = pattern.replace(/\/\*$/, "")
    for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
      const dir = join(parent, entry.name)
      if (!entry.isDirectory() || !existsSync(join(repoRoot, dir, "package.json"))) continue

      const { name } = readManifest(dir)
      if (name) byName.set(name, dir)
    }
  }

  return byName
}

async function run(
  command: string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), 4_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function readManifest<T = PackageJson>(repoRelativeDir: string): T {
  return JSON.parse(readFileSync(join(repoRoot, repoRelativeDir, "package.json"), "utf8")) as T
}
