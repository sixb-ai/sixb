import type { Dirent } from "node:fs"
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"

type PackageJson = {
  name?: string
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
