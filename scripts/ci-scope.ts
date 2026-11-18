/**
 * Whether a pull request has to run one E2E suite.
 *
 * The E2E jobs are most of CI's runner time, and many pull requests cannot reach many of them: a
 * change to the agent UI does not run differently against Redis. Each E2E job asks this script
 * about its own suite before it installs anything. The suite runs when a changed file belongs to
 * a workspace the suite reaches.
 *
 * **Prove, or run.** Anything that cannot be proven unrelated runs the suite:
 *
 * - a changed file outside every workspace that is not plain documentation — root configs,
 *   `bun.lock`, `scripts/`, `.github/`, the shared `storage/tests` fixtures;
 * - a suite that is not a workspace, a diff git cannot produce, or a decision that throws;
 * - a push to `main`, where the workflow never asks. Every suite runs there, so a dependency this
 *   graph misses fails on `main` at the commit that introduced it rather than never.
 *
 * **What a suite reaches.** The suite's workspace, everything its tests reach, and from there,
 * transitively, everything shipped code reaches. Two kinds of edge, because they travel
 * differently:
 *
 * - Runtime edges come from `dependencies`, `peerDependencies` and `optionalDependencies`, and
 *   from every file outside `tests/`. They are followed transitively: `@sixb/pg`'s suite runs
 *   `@sixb/core`'s code, and whatever that runs.
 * - Test edges come from `devDependencies` and from `tests/`. They are followed only for the suite
 *   being decided. `@sixb/core`'s publish test packs `@sixb/ui`, but `@sixb/pg`'s suite never
 *   runs that test, so a change to `@sixb/ui` does not reach it. A test helper borrowed from
 *   another workspace's `tests/` brings that workspace's test edges along.
 *
 * An edge is anything that says one workspace reaches another: a manifest entry, an import
 * specifier (bare or relative), or a path a test spells out — `"../../core/tests/helpers"`,
 * `resolve(import.meta.dir, "..", "..", "app")`, `"packages/core"`. Over-approximating is the
 * intent: an extra edge costs a suite that did not need to run, a missing one the suite that did.
 *
 * Unit test files are not read. Every unit test runs on every pull request, and no E2E file
 * imports one; reading them would only add the edges of tests that scan the whole repository.
 */

import { appendFile, readFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { Glob } from "bun"

const LOG_PREFIX = "[CiScope]"

/** Changed paths that cannot change what an E2E suite executes. */
const DOCUMENTATION = [/^docs\//, /^[^/]+\.md$/, /^\.github\/pull_request_template\.md$/] as const

const SOURCE_GLOB = new Glob("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json,yml,yaml,toml}")
const SCRIPT_FILE = /\.[mc]?[jt]sx?$/
const UNIT_TEST = /\.test\.[mc]?[jt]sx?$/
const IGNORED_SEGMENTS = new Set(["node_modules", "dist", ".tsbuild", ".sixb", ".next", "coverage"])

const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const

/** `"../src/x"`, `"../../core/tests/y"`, `${import.meta.dir}/../../app` — any relative path. */
const RELATIVE_PATH = /(?:\.\.?\/)+[\w@.-]+(?:\/[\w@.-]+)*/g

/** `resolve(import.meta.dir, "..", "..", "app")`, and the same through `join`. */
const PATH_SEGMENTS = /(?:resolve|join)\(\s*import\.meta\.dir((?:\s*,\s*["'][^"']*["'])+)\s*\)/g

/** `"packages/core"`, `["storage/pg", "pg"]` — a workspace spelled from the repo root. */
const WORKSPACE_PATH =
  /["'`](?:\.\/)?((?:apps|auth|packages|models|connectors|deploy|env|broker|queues|sandboxes|storage|loggers|examples)\/[\w.-]+)/g

export interface Workspace {
  readonly name: string
  /** Repo-relative, `/`-separated, no trailing slash. */
  readonly directory: string
}

export interface WorkspaceGraph {
  readonly workspaces: readonly Workspace[]
  /** Workspace → what its shipped code reaches. Followed transitively. */
  readonly runtime: ReadonlyMap<string, ReadonlySet<string>>
  /** Workspace → what its tests reach. Followed for the suite being decided. */
  readonly tests: ReadonlyMap<string, ReadonlySet<string>>
  /** Workspace → workspaces whose `tests/` its tests import from. Their test edges come along. */
  readonly borrowed: ReadonlyMap<string, ReadonlySet<string>>
}

export interface SuiteDecision {
  readonly run: boolean
  readonly reason: string
}

export function decideSuite(input: {
  readonly graph: WorkspaceGraph
  /** The workspace whose `test:e2e` is being decided. */
  readonly suite: string
  /** Repo-relative changed paths, or `null` when git could not produce them. */
  readonly changedPaths: readonly string[] | null
}): SuiteDecision {
  const { graph, suite, changedPaths } = input
  if (changedPaths === null) return { run: true, reason: "git could not list the changed files" }
  if (!graph.workspaces.some((workspace) => workspace.name === suite)) {
    return { run: true, reason: `${suite} is not a workspace` }
  }

  const reached = suiteReach(graph, suite)
  for (const path of changedPaths) {
    if (DOCUMENTATION.some((pattern) => pattern.test(path))) continue

    const owner = owningWorkspace(graph.workspaces, path)
    if (!owner) return { run: true, reason: `${path} is outside every workspace` }
    if (reached.has(owner.name)) return { run: true, reason: `${path} is in ${owner.name}` }
  }

  return {
    run: false,
    reason: `none of the ${reached.size} workspaces ${suite} reaches changed`,
  }
}

/** Every workspace an E2E run of `suite` can execute or read. */
export function suiteReach(graph: WorkspaceGraph, suite: string): Set<string> {
  const reached = new Set<string>()
  const seen = new Set<string>()
  const pending: { name: string; tests: boolean }[] = [{ name: suite, tests: true }]

  while (pending.length > 0) {
    const { name, tests } = pending.pop() as { name: string; tests: boolean }
    const key = `${tests ? "tests" : "runtime"}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    reached.add(name)

    for (const next of graph.runtime.get(name) ?? []) pending.push({ name: next, tests: false })
    if (!tests) continue
    for (const next of graph.tests.get(name) ?? []) pending.push({ name: next, tests: false })
    for (const next of graph.borrowed.get(name) ?? []) pending.push({ name: next, tests: true })
  }

  return reached
}

function owningWorkspace(workspaces: readonly Workspace[], path: string): Workspace | undefined {
  let owner: Workspace | undefined
  for (const workspace of workspaces) {
    if (!path.startsWith(`${workspace.directory}/`)) continue
    // The deepest directory wins, should a workspace ever nest inside another.
    if (!owner || workspace.directory.length > owner.directory.length) owner = workspace
  }
  return owner
}

export async function readWorkspaceGraph(root: string): Promise<WorkspaceGraph> {
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    workspaces: string[]
  }

  const manifests: { directory: string; manifest: Manifest }[] = []
  for (const pattern of rootManifest.workspaces) {
    for await (const file of new Glob(`${pattern}/package.json`).scan({ cwd: root })) {
      const manifest = JSON.parse(await readFile(join(root, file), "utf8")) as Manifest
      if (manifest.name) manifests.push({ directory: toPosix(dirname(file)), manifest })
    }
  }

  const workspaces: Workspace[] = manifests.map(({ directory, manifest }) => ({
    name: manifest.name as string,
    directory,
  }))
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const transpiler = new Bun.Transpiler({ loader: "tsx", trimUnusedImports: false })

  const runtime = new Map<string, Set<string>>()
  const tests = new Map<string, Set<string>>()
  const borrowed = new Map<string, Set<string>>()

  await Promise.all(
    manifests.map(async ({ directory, manifest }) => {
      const name = manifest.name as string
      const runtimeEdges = new Set<string>()
      const testEdges = new Set<string>()
      const borrowedEdges = new Set<string>()

      for (const field of RUNTIME_FIELDS) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (byName.has(dependency)) runtimeEdges.add(dependency)
        }
      }
      for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
        if (byName.has(dependency)) testEdges.add(dependency)
      }

      for await (const file of SOURCE_GLOB.scan({ cwd: join(root, directory), dot: true })) {
        const segments = toPosix(file).split("/")
        if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) continue
        if (UNIT_TEST.test(file)) continue

        const isTest = segments[0] === "tests"
        const absolute = join(root, directory, file)
        const text = await readFile(absolute, "utf8")

        for (const target of referencedTargets(text, absolute, isTest, root, transpiler)) {
          const path = isAbsolute(target) ? toPosix(relative(root, target)) : undefined
          const owner = path ? owningWorkspace(workspaces, `${path}/`) : packageOf(byName, target)
          if (!owner || owner.name === name) continue

          ;(isTest ? testEdges : runtimeEdges).add(owner.name)
          if (isTest && path?.startsWith(`${owner.directory}/tests/`)) borrowedEdges.add(owner.name)
        }
      }

      runtime.set(name, runtimeEdges)
      tests.set(name, testEdges)
      borrowed.set(name, borrowedEdges)
    })
  )

  return { workspaces, runtime, tests, borrowed }
}

/** Absolute paths a file points at, and bare package specifiers it imports. */
function referencedTargets(
  text: string,
  file: string,
  isTest: boolean,
  root: string,
  transpiler: Bun.Transpiler
): string[] {
  const directory = dirname(file)
  const found: string[] = []

  if (SCRIPT_FILE.test(file)) {
    try {
      for (const { path } of transpiler.scanImports(text)) {
        found.push(path.startsWith(".") ? resolve(directory, path) : path)
      }
    } catch {
      // A file Bun cannot parse is still read for the paths it spells out, below.
    }
  }

  for (const match of text.matchAll(RELATIVE_PATH)) found.push(resolve(directory, match[0]))
  for (const match of text.matchAll(PATH_SEGMENTS)) {
    const segments = [...(match[1] as string).matchAll(/["']([^"']*)["']/g)].map((s) => s[1] ?? "")
    found.push(normalize(join(directory, ...segments)))
  }

  // Shipped code names sibling directories only in prose, where these would be noise. Tests name
  // them to pack, build or read them.
  if (isTest) {
    for (const match of text.matchAll(WORKSPACE_PATH)) found.push(join(root, match[1] as string))
  }

  return found
}

/** `@sixb/core/storage` → `@sixb/core`, `create-sixb/x` → `create-sixb`. */
function packageOf(byName: ReadonlyMap<string, Workspace>, specifier: string) {
  const parts = specifier.split("/")
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string)
  return byName.get(name)
}

interface Manifest {
  readonly name?: string
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
}

function toPosix(path: string): string {
  return path.split(sep).join("/")
}

async function changedPaths(base: string, head: string): Promise<string[] | null> {
  const child = Bun.spawn(["git", "diff", "--name-only", "--no-renames", base, head], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return code === 0 ? output.split("\n").filter((line) => line.length > 0) : null
}

if (import.meta.main) {
  const [suite, base, head = "HEAD"] = process.argv.slice(2)
  let decision: SuiteDecision
  try {
    if (!suite || !base) throw new Error("usage: bun scripts/ci-scope.ts <suite> <base> [head]")
    const [graph, paths] = await Promise.all([
      readWorkspaceGraph(process.cwd()),
      changedPaths(base, head),
    ])
    decision = decideSuite({ graph, suite, changedPaths: paths })
  } catch (error) {
    decision = { run: true, reason: `the scope could not be decided: ${String(error)}` }
  }

  // Skipping is the dangerous outcome, so it says why, out loud.
  console.log(`${LOG_PREFIX} ${decision.run ? "run" : "skip"} ${suite}: ${decision.reason}`)
  const output = process.env.GITHUB_OUTPUT
  if (output) await appendFile(output, `run=${decision.run}\n`)
}
