/**
 * Whether a pull request has to run one E2E suite.
 *
 * The E2E jobs are most of CI's runner time, and many pull requests cannot reach many of them: a
 * change to the agent UI does not run differently against Redis. Each E2E job asks this script
 * about its own suite before it installs anything. The suite runs when a changed file belongs to
 * a workspace the suite reaches, directly or through any chain of others.
 *
 * **Prove, or run.** Anything that cannot be proven unrelated runs the suite:
 *
 * - a changed file outside every workspace that is not plain documentation — root configs,
 *   `bun.lock`, `scripts/`, `.github/`, the shared `storage/tests` fixtures;
 * - a suite that is not a workspace, a diff git cannot produce, or a decision that throws;
 * - a push to `main`, where the workflow never asks. Every suite runs there, so a dependency this
 *   graph misses fails on `main` at the commit that introduced it rather than never.
 *
 * **What counts as reaching.** Anything that says one workspace uses another:
 *
 * - a manifest entry of any kind, `devDependencies` included;
 * - an import, bare or relative, and a relative path written anywhere: `"../../core/tests/x"`,
 *   `${import.meta.dir}/../../app`, `resolve(import.meta.dir, "..", "..", "app")`;
 * - in tests and in data files (JSON, YAML, TOML), a workspace named from the repo root:
 *   `"packages/core"`, `join(repoRoot, "packages", "cli")`. That is how E2E tests pack, spawn and
 *   build siblings without importing them;
 * - in data files, a package name, as in a template's `package.json` or a fixture's.
 *
 * Every edge is followed transitively. Telling test-only edges apart would skip a few more suites
 * and miss more ways a test reaches a sibling; over-approximating is the intent, since an extra
 * edge costs a suite that did not need to run and a missing one costs the suite that did.
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

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const

/** `"../src/x"`, `"../../core/tests/y"`, `${import.meta.dir}/../../app` — any relative path. */
const RELATIVE_PATH = /(?:\.\.?\/)+[\w@.-]+(?:\/[\w@.-]+)*/g

/** `resolve(import.meta.dir, "..", "..", "app")`, and the same through `join`. */
const PATH_SEGMENTS = /(?:resolve|join)\(\s*import\.meta\.dir((?:\s*,\s*["'][^"']*["'])+)\s*\)/g

/** A parser per extension: the TSX grammar rejects `<T>(x) => x` and `<T>value` in a `.ts` file. */
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts", trimUnusedImports: false }),
  tsx: new Bun.Transpiler({ loader: "tsx", trimUnusedImports: false }),
}

export interface Workspace {
  readonly name: string
  /** Repo-relative, `/`-separated, no trailing slash. */
  readonly directory: string
}

export interface WorkspaceGraph {
  readonly workspaces: readonly Workspace[]
  /** Workspace → the workspaces it reaches directly. */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>
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

/** `suite` and every workspace it reaches, transitively. */
export function suiteReach(graph: WorkspaceGraph, suite: string): Set<string> {
  const reached = new Set<string>()
  const pending = [suite]
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (reached.has(name)) continue
    reached.add(name)
    for (const next of graph.edges.get(name) ?? []) pending.push(next)
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
  const patterns = namingPatterns(rootManifest.workspaces, workspaces)

  const edges = new Map<string, Set<string>>()
  await Promise.all(
    manifests.map(async ({ directory, manifest }) => {
      const name = manifest.name as string
      const reached = new Set<string>()

      for (const field of DEPENDENCY_FIELDS) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          if (byName.has(dependency)) reached.add(dependency)
        }
      }

      for await (const file of SOURCE_GLOB.scan({ cwd: join(root, directory), dot: true })) {
        const segments = toPosix(file).split("/")
        if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) continue
        if (UNIT_TEST.test(file)) continue

        const absolute = join(root, directory, file)
        const text = await readFile(absolute, "utf8")
        const namesSiblings = segments[0] === "tests" || !SCRIPT_FILE.test(file)

        for (const target of referencedTargets(text, absolute, root, namesSiblings, patterns)) {
          const owner = isAbsolute(target)
            ? owningWorkspace(workspaces, `${toPosix(relative(root, target))}/`)
            : packageOf(byName, target)
          if (owner && owner.name !== name) reached.add(owner.name)
        }
      }

      edges.set(name, reached)
    })
  )

  return { workspaces, edges }
}

interface NamingPatterns {
  /** `"packages/core"` — a workspace spelled from the repo root as one string. */
  readonly path: RegExp
  /** `"packages", "cli"` — the same as two path segments. */
  readonly segments: RegExp
  /** `"@sixb/cli"`, `"@sixb/core/storage"` — a workspace by package name, in a string. */
  readonly name: RegExp
}

/** Built from the root `workspaces` globs, so a new workspace area needs no edit here. */
function namingPatterns(
  globs: readonly string[],
  workspaces: readonly Workspace[]
): NamingPatterns {
  const areas = globs.map((glob) => escapeRegExp(glob.replace(/\/\*$/, ""))).join("|")
  const names = workspaces.map((workspace) => escapeRegExp(workspace.name)).join("|")
  return {
    path: new RegExp(`["'\`](?:\\./)?((?:${areas})/[\\w.-]+)`, "g"),
    segments: new RegExp(`["'](${areas})["']\\s*,\\s*["']([\\w.-]+)["']`, "g"),
    name: new RegExp(`["'\`]((?:${names})(?:/[\\w./-]*)?)["'\`]`, "g"),
  }
}

/** Absolute paths a file points at, and package specifiers it names. */
function referencedTargets(
  text: string,
  file: string,
  root: string,
  namesSiblings: boolean,
  patterns: NamingPatterns
): string[] {
  const directory = dirname(file)
  const found: string[] = []

  if (SCRIPT_FILE.test(file)) {
    const transpiler = /\.[mc]?ts$/.test(file) ? TRANSPILERS.ts : TRANSPILERS.tsx
    try {
      // `scanImports` rejects a leading `#!`; blank it and keep the line count.
      for (const { path } of transpiler.scanImports(text.replace(/^#!.*/, ""))) {
        found.push(path.startsWith(".") ? resolve(directory, path) : path)
      }
    } catch {
      // Unparseable: fall back to every package name the file spells in a string.
      for (const match of text.matchAll(patterns.name)) found.push(match[1] as string)
    }
  }

  for (const match of text.matchAll(RELATIVE_PATH)) found.push(resolve(directory, match[0]))
  for (const match of text.matchAll(PATH_SEGMENTS)) {
    const segments = [...(match[1] as string).matchAll(/["']([^"']*)["']/g)].map((s) => s[1] ?? "")
    found.push(normalize(join(directory, ...segments)))
  }

  // Shipped code names siblings mostly in prose and messages, where this would only add noise.
  // Tests and data files name them to pack, spawn, build or install them.
  if (namesSiblings) {
    for (const match of text.matchAll(patterns.path)) found.push(join(root, match[1] as string))
    for (const match of text.matchAll(patterns.segments)) {
      found.push(join(root, match[1] as string, match[2] as string))
    }
  }
  // A package name in test code is as often an exclusion (`entry.name === "create-sixb"`) as a
  // use; in a data file it is a template's or a fixture's dependency.
  if (!SCRIPT_FILE.test(file)) {
    for (const match of text.matchAll(patterns.name)) found.push(match[1] as string)
  }

  return found
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

  // Skipping is the dangerous outcome, so it says why, out loud — on the check's summary too.
  console.log(`${LOG_PREFIX} ${decision.run ? "run" : "skip"} ${suite}: ${decision.reason}`)
  if (!decision.run && process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=${suite} E2E skipped::${decision.reason}`)
  }
  const output = process.env.GITHUB_OUTPUT
  if (output) await appendFile(output, `run=${decision.run}\n`)
}
