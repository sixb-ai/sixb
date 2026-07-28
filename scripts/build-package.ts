import type { Dirent } from "node:fs"
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"

type PackageJson = {
  name?: string
  types?: string
  exports?: ExportsMap
  sixbBuild?: {
    entrypoints?: string[]
    assets?: Array<{
      from: string
      to: string
    }>
  }
}

type ExportTarget =
  | string
  | string[]
  | {
      bun?: ExportTarget
      browser?: ExportTarget
      import?: ExportTarget
      default?: ExportTarget
      types?: ExportTarget
    }

type ExportsMap = Record<string, ExportTarget> | ExportTarget

const packageRoot = process.cwd()
const srcRoot = join(packageRoot, "src")
const distRoot = join(packageRoot, "dist")
const packageJsonPath = join(packageRoot, "package.json")
const buildConfigDir = join(packageRoot, ".tsbuild")

const packageJson = (await Bun.file(packageJsonPath).json()) as PackageJson
const packageName = packageJson.name ?? relative(process.cwd(), packageRoot)

// Root builds remove dist before TypeScript emits declarations. Package-scoped builds and
// prepack runs preserve those declarations but remove every runtime artifact so stale chunks,
// styles, and copied assets cannot leak into a later tarball.
await cleanRuntimeOutputs(distRoot)
await mkdir(distRoot, { recursive: true })
await mkdir(buildConfigDir, { recursive: true })

await ensureDeclarations()

const entrypoints = await resolveEntrypoints(
  packageJson.exports,
  packageJson.sixbBuild?.entrypoints ?? []
)

if (entrypoints.length > 0) {
  const bundleTsconfigPath = await writeBundleTsconfig()
  const result = await Bun.build({
    entrypoints,
    outdir: distRoot,
    root: srcRoot,
    target: "bun",
    format: "esm",
    packages: "external",
    sourcemap: "external",
    // Share modules between entrypoints via chunks. Without splitting, each
    // subpath entry bundles its own copy of shared modules, so stateful
    // singletons (e.g. the generated SDK client) and error classes lose
    // identity across entries for published `import`-condition consumers.
    splitting: true,
    // React stays external here, so a development JSX runtime would ship a bare
    // `react/jsx-dev-runtime` import. In any consumer that bundles for
    // production React resolves that to a stub whose `jsxDEV` is `undefined`,
    // and every component throws `jsxDEV is not a function`. This is also the
    // only knob that switches the runtime: neither an ambient NODE_ENV nor
    // `bun build --define` does it.
    //
    // Bun folds `process.env.NODE_ENV` into `dist` whether or not we define it,
    // so this pins the value rather than introducing the fold — and
    // `"production"` is the honest value for a published artifact.
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: bundleTsconfigPath,
  })

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    throw new Error(`[SixbBuild] Failed to build ${packageName}`)
  }
}

await copyAssets(packageJson.sixbBuild?.assets ?? [])

/**
 * Emit the `.d.ts` files this package promises, if they are not on disk already.
 *
 * Only `tsc -b` writes declarations, and it lives in the root `build:types` script — so a
 * package-scoped build, or the `prepack` that `bun publish` runs, would otherwise produce a
 * tarball whose `types` entries point at nothing. `cleanRuntimeOutputs` preserves declarations
 * rather than rebuilding them, which is what makes the gap survivable and therefore invisible.
 *
 * The happy path is a handful of `stat` calls: after a root build every target already exists.
 * When one is missing we shell out to `tsc -b`, which also builds this package's project
 * references, so it can write into a sibling's `dist` — expected inside a publish loop.
 */
async function ensureDeclarations(): Promise<void> {
  const declarations = declaredTypeTargets()
  if (declarations.length === 0) return
  if (await allExist(declarations)) return

  // `--force` is required, not defensive: `dist` and `.tsbuild/*.tsbuildinfo` are two halves of
  // one state, and a `dist` that lost its declarations still has a buildinfo claiming they were
  // emitted. Without it `tsc -b` reports "up to date" and writes nothing.
  console.log(`[SixbBuild] ${packageName}: emitting missing declarations with tsc -b --force.`)
  const proc = Bun.spawn([process.execPath, "x", "tsc", "-b", "tsconfig.build.json", "--force"], {
    cwd: packageRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await proc.exited) !== 0) {
    throw new Error(`[SixbBuild] ${packageName}: tsc -b failed while emitting declarations.`)
  }

  const missing = await missingPaths(declarations)
  if (missing.length > 0) {
    throw new Error(
      `[SixbBuild] ${packageName} declares types that tsc did not emit:\n  ${missing.join("\n  ")}`
    )
  }
}

/** Every `./dist/**.d.ts` path this manifest promises, from `types` and from `exports`. */
function declaredTypeTargets(): string[] {
  const targets = new Set<string>()
  collectTypeTargets(packageJson.types, targets)
  collectExportTypeTargets(packageJson.exports, targets)
  return [...targets].sort((a, b) => a.localeCompare(b))
}

function collectExportTypeTargets(target: ExportTarget | undefined, targets: Set<string>): void {
  if (!target || typeof target === "string") return

  if (Array.isArray(target)) {
    for (const item of target) collectExportTypeTargets(item, targets)
    return
  }

  for (const [condition, value] of Object.entries(target)) {
    if (condition === "types") {
      collectTypeTargets(value, targets)
      continue
    }
    collectExportTypeTargets(value as ExportTarget, targets)
  }
}

function collectTypeTargets(target: ExportTarget | undefined, targets: Set<string>): void {
  if (typeof target === "string") {
    // Wildcard subpaths expand per source file; there is no single path to stat.
    if (target.endsWith(".d.ts") && !target.includes("*")) targets.add(target)
    return
  }
  if (Array.isArray(target)) {
    for (const item of target) collectTypeTargets(item, targets)
  }
}

async function allExist(targets: string[]): Promise<boolean> {
  return (await missingPaths(targets)).length === 0
}

async function missingPaths(targets: string[]): Promise<string[]> {
  const missing: string[] = []
  for (const target of targets) {
    if (!(await Bun.file(resolve(packageRoot, target)).exists())) missing.push(target)
  }
  return missing
}

async function cleanRuntimeOutputs(directory: string): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await cleanRuntimeOutputs(path)
      if ((await readdir(path)).length === 0) {
        await rm(path, { recursive: true, force: true })
      }
      continue
    }

    if (!entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.ts.map")) {
      await rm(path, { force: true })
    }
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function writeBundleTsconfig(): Promise<string> {
  const bundleTsconfigPath = join(buildConfigDir, "tsconfig.bundle.json")
  await writeFile(
    bundleTsconfigPath,
    `${JSON.stringify(
      {
        extends: "../tsconfig.json",
        compilerOptions: {
          paths: {},
        },
      },
      null,
      2
    )}\n`
  )
  return bundleTsconfigPath
}

async function resolveEntrypoints(
  exportsMap: ExportsMap | undefined,
  configuredEntrypoints: string[]
): Promise<string[]> {
  const sourceTargets = new Set<string>()

  for (const entrypoint of configuredEntrypoints) {
    sourceTargets.add(entrypoint)
  }

  if (!exportsMap && configuredEntrypoints.length === 0) {
    // Bin-only packages (e.g. @sixb/cli) have no exports and nothing to bundle;
    // their build still runs for copyAssets.
    if (await Bun.file(join(srcRoot, "index.ts")).exists()) {
      sourceTargets.add("./src/index.ts")
    }
  } else if (typeof exportsMap === "string" || Array.isArray(exportsMap)) {
    collectSourceTargets(exportsMap, sourceTargets)
  } else {
    for (const target of Object.values(exportsMap)) {
      collectSourceTargets(target, sourceTargets)
    }
  }

  const entrypoints: string[] = []
  for (const target of sourceTargets) {
    if (!isBuildableSource(target)) continue

    if (target.includes("*")) {
      entrypoints.push(...(await expandSourcePattern(target)))
      continue
    }

    entrypoints.push(resolve(packageRoot, target))
  }

  return [...new Set(entrypoints)].sort((a, b) => a.localeCompare(b))
}

function collectSourceTargets(target: ExportTarget | undefined, sourceTargets: Set<string>): void {
  if (!target) return

  if (typeof target === "string") {
    if (target.startsWith("./src/")) {
      sourceTargets.add(target)
    }
    return
  }

  if (Array.isArray(target)) {
    for (const item of target) {
      collectSourceTargets(item, sourceTargets)
    }
    return
  }

  collectSourceTargets(target.bun, sourceTargets)
}

function isBuildableSource(target: string): boolean {
  const extension = extname(target)
  return extension === ".ts" || extension === ".tsx"
}

async function expandSourcePattern(pattern: string): Promise<string[]> {
  const starIndex = pattern.indexOf("*")
  const prefix = pattern.slice(0, starIndex)
  const suffix = pattern.slice(starIndex + 1)
  const directory = resolve(packageRoot, prefix.slice(0, prefix.lastIndexOf("/") + 1))
  const filePrefix = prefix.slice(prefix.lastIndexOf("/") + 1)
  const entries = await readdir(directory, { withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.startsWith(filePrefix) && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

async function copyAssets(assets: NonNullable<PackageJson["sixbBuild"]>["assets"]): Promise<void> {
  for (const asset of assets ?? []) {
    await cp(resolve(packageRoot, asset.from), resolve(packageRoot, asset.to), {
      recursive: true,
      force: true,
    })
  }
}
