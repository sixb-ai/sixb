import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { docsConfig } from "../../apps/docs/src/docs/config"
import { decideDocsBuild, type GitProbe, gitProbe, WATCHED_PATHS } from "../docs-vercel-ignore"
import { internalDependencies, type PackageJson } from "../publishable-packages"

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
  test("builds when the branch has no previous deployment to compare against", () => {
    expect(decideDocsBuild({ previousSha: undefined, git: probe() })).toEqual({
      build: true,
      reason: "no previous successful deployment for this branch",
    })
  })

  test("builds when the previous commit fell out of the shallow clone", () => {
    const decision = decideDocsBuild({
      previousSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f009876543",
      git: probe({ hasCommit: () => false }),
    })

    expect(decision.build).toBe(true)
    expect(decision.reason).toContain("outside the shallow clone")
  })

  test("builds when git cannot answer at all", () => {
    const decision = decideDocsBuild({
      previousSha: "abc1234",
      git: probe({ changedPaths: () => null }),
    })

    expect(decision.build).toBe(true)
    expect(decision.reason).toContain("could not diff")
  })

  test("builds when a watched path changed, and names the file that caused it", () => {
    const decision = decideDocsBuild({
      previousSha: "abc1234",
      git: probe({ changedPaths: () => ["docs/deployment/overview.md"] }),
    })

    expect(decision.build).toBe(true)
    expect(decision.reason).toContain("docs/deployment/overview.md")
  })

  test("skips only when nothing watched changed", () => {
    const decision = decideDocsBuild({ previousSha: "abc1234", git: probe() })

    expect(decision.build).toBe(false)
    expect(decision.reason).toContain("no watched path changed")
  })

  test("diffs the whole gap since the last deployment, not just the last commit", () => {
    const ranges: string[] = []
    decideDocsBuild({
      previousSha: "abc1234",
      git: probe({
        changedPaths: (range) => {
          ranges.push(range)
          return []
        },
      }),
    })

    expect(ranges).toEqual(["abc1234..HEAD"])
  })

  test("asks git about every watched path", () => {
    let asked: readonly string[] = []
    decideDocsBuild({
      previousSha: "abc1234",
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

describe("gitProbe", () => {
  function commitAll(cwd: string, message: string): string {
    Bun.spawnSync(["git", "add", "-A"], { cwd })
    Bun.spawnSync(["git", "commit", "-q", "-m", message], { cwd })
    return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" })
      .stdout.toString()
      .trim()
  }

  function repository(): string {
    const cwd = mkdtempSync(join(tmpdir(), "sixb-docs-ignore-"))
    Bun.spawnSync(["git", "init", "-q"], { cwd })
    Bun.spawnSync(["git", "config", "user.email", "test@sixb.local"], { cwd })
    Bun.spawnSync(["git", "config", "user.name", "Sixb Test"], { cwd })
    mkdirSync(join(cwd, "docs"), { recursive: true })
    mkdirSync(join(cwd, "apps", "docs"), { recursive: true })
    writeFileSync(join(cwd, "docs", "overview.md"), "# one\n")
    writeFileSync(join(cwd, "apps", "docs", "page.tsx"), "export default null\n")
    writeFileSync(join(cwd, "README.md"), "# repo\n")
    return cwd
  }

  /**
   * Vercel runs the ignore step from the project's root directory, not the repo's. The `:/` anchor
   * is what makes that irrelevant, and it is the assumption the old rule silently depended on.
   */
  test("resolves watched paths from a subdirectory, the way Vercel runs it", () => {
    const cwd = repository()
    try {
      const base = commitAll(cwd, "initial")
      writeFileSync(join(cwd, "docs", "overview.md"), "# two\n")
      commitAll(cwd, "docs: edit a page")

      const probeFromSubdirectory = gitProbe(join(cwd, "apps", "docs"))

      expect(probeFromSubdirectory.changedPaths(`${base}..HEAD`, WATCHED_PATHS)).toEqual([
        "docs/overview.md",
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("reports nothing for a change outside the watched paths", () => {
    const cwd = repository()
    try {
      const base = commitAll(cwd, "initial")
      writeFileSync(join(cwd, "README.md"), "# changed\n")
      commitAll(cwd, "readme: edit")

      expect(gitProbe(cwd).changedPaths(`${base}..HEAD`, WATCHED_PATHS)).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test("reports an absent commit rather than throwing", () => {
    const cwd = repository()
    try {
      commitAll(cwd, "initial")
      const absent = "0f1e2d3c4b5a69788796a5b4c3d2e1f009876543"

      expect(gitProbe(cwd).hasCommit(absent)).toBe(false)
      expect(gitProbe(cwd).changedPaths(`${absent}..HEAD`, WATCHED_PATHS)).toBeNull()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
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

  test("every workspace dependency of the site lives under a watched path", () => {
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

    for (const name of internalDependencies(readManifest(dir))) {
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

function readManifest<T = PackageJson>(repoRelativeDir: string): T {
  return JSON.parse(readFileSync(join(repoRoot, repoRelativeDir, "package.json"), "utf8")) as T
}
