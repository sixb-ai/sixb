import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Checks the tarballs the way a consumer meets them.
 *
 * Nothing else in this repo imports a built `dist`: Bun resolves the `bun` export condition to
 * `src`, and the type-check graph reads package `src` through project references. So the published
 * artifact is the one thing no other test covers — a missing `.d.ts`, a development JSX runtime, or
 * an `exports` target naming a file that was never built all ship green without this.
 *
 * `@sixb/core`, `@sixb/client` and `@sixb/ui` are a complete `@sixb/*` dependency closure (core and
 * ui have none; client depends on core), so extracting these three is enough to resolve every
 * subpath they declare.
 *
 * What this proves: every declared target is in the tarball, the compiled JavaScript parses and its
 * own imports resolve, the declarations resolve and type-check from a consumer's tsconfig, and no
 * published file reaches for a development JSX runtime. What it does not prove: that importing a
 * subpath *executes* correctly — that needs a real install with running infrastructure.
 */

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const packagesUnderTest = ["packages/core", "packages/client", "packages/ui"] as const

type PackageJson = {
  name: string
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: ExportTarget
}

type ExportTarget = string | null | ExportTarget[] | { [condition: string]: ExportTarget }

interface ExtractedPackage {
  readonly name: string
  readonly dir: string
  readonly manifest: PackageJson
  readonly packedFiles: readonly string[]
}

let layoutRoot: string
let nodeModulesDir: string
let extracted: ExtractedPackage[]

beforeAll(async () => {
  layoutRoot = await mkdtemp(join(tmpdir(), "sixb-published-"))
  const artifactsDir = join(layoutRoot, "artifacts")
  nodeModulesDir = join(layoutRoot, "node_modules")
  await mkdir(artifactsDir, { recursive: true })
  await mkdir(join(nodeModulesDir, "@sixb"), { recursive: true })

  // Third-party packages and their types come from the repo install; only `@sixb/*` is isolated,
  // so a subpath can never resolve back to a workspace symlink and pass on `src`.
  await linkThirdPartyDependencies()

  extracted = []
  for (const packageDir of packagesUnderTest) {
    const manifest = await readManifest(join(repoRoot, packageDir, "package.json"))
    const destination = join(nodeModulesDir, manifest.name)
    await mkdir(destination, { recursive: true })

    // `bun pm pack` runs `prepack`, so this builds whatever is missing instead of depending on a
    // root build having happened first.
    const tarball = packPackage(join(repoRoot, packageDir), artifactsDir)
    extractPackage(tarball, destination)

    extracted.push({
      name: manifest.name,
      dir: destination,
      manifest: await readManifest(join(destination, "package.json")),
      packedFiles: await listFiles(destination),
    })
  }
}, 300_000)

afterAll(async () => {
  if (layoutRoot) await rm(layoutRoot, { recursive: true, force: true })
})

describe("published artifacts", () => {
  test("packs every file the manifest names", () => {
    for (const pkg of extracted) {
      const missing = declaredTargets(pkg.manifest).filter(
        (target) => !matchesPackedFile(target, pkg.packedFiles)
      )
      expect({ package: pkg.name, missing }).toEqual({ package: pkg.name, missing: [] })
    }
  })

  test("ships compiled JavaScript that parses and resolves its own imports", async () => {
    for (const pkg of extracted) {
      // Wildcard subpaths such as `./hooks/*` are real published surface, so expand them to the
      // files that actually shipped rather than skipping them.
      const compiled = declaredTargets(pkg.manifest)
        .filter((target) => target.endsWith(".js"))
        .flatMap((target) => expandTarget(target, pkg.packedFiles))
      expect(compiled.length).toBeGreaterThan(0)

      const result = await Bun.build({
        entrypoints: compiled.map((relativePath) => join(pkg.dir, relativePath)),
        // Only this package's own graph is under test; its dependencies are somebody else's.
        packages: "external",
        target: "bun",
        throw: false,
      })

      const logs = result.success ? [] : result.logs.map(String)
      expect({ package: pkg.name, logs }).toEqual({ package: pkg.name, logs: [] })
    }
  }, 120_000)

  test("never ships a development JSX runtime", async () => {
    for (const pkg of extracted) {
      const offenders: string[] = []
      for (const relativePath of pkg.packedFiles) {
        if (!relativePath.endsWith(".js")) continue
        const source = await readFile(join(pkg.dir, relativePath), "utf8")
        if (source.includes("react/jsx-dev-runtime")) offenders.push(relativePath)
      }

      // React is external in published bundles, so a consumer that bundles for production resolves
      // `react/jsx-dev-runtime` to a stub whose `jsxDEV` is undefined and every component throws.
      expect({ package: pkg.name, offenders }).toEqual({ package: pkg.name, offenders: [] })
    }
  })

  test("declarations resolve and type-check from a consumer tsconfig", async () => {
    const subpaths = extracted.flatMap((pkg) => importableSubpaths(pkg))
    expect(subpaths.length).toBeGreaterThan(40)

    const consumerDir = join(layoutRoot, "consumer")
    await mkdir(consumerDir, { recursive: true })
    await writeFile(
      join(consumerDir, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            // Matches what a consumer's tsconfig looks like. The question here is whether our
            // declarations resolve and are usable, not whether their internals are pristine.
            skipLibCheck: true,
            types: ["bun"],
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            noEmit: true,
          },
          include: ["index.ts"],
        },
        null,
        2
      )}\n`
    )
    await writeFile(
      join(consumerDir, "index.ts"),
      `${subpaths.map((subpath, index) => `import * as m${index} from "${subpath}"`).join("\n")}
export const loaded = [${subpaths.map((_, index) => `m${index}`).join(", ")}].length
`
    )

    const result = Bun.spawnSync(
      [process.execPath, "x", "tsc", "--noEmit", "-p", join(consumerDir, "tsconfig.json")],
      { cwd: repoRoot, stdout: "pipe", stderr: "pipe" }
    )

    const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
    expect(output).toBe("")
    expect(result.exitCode).toBe(0)
  }, 300_000)
})

async function linkThirdPartyDependencies(): Promise<void> {
  const entries = await readdir(join(repoRoot, "node_modules"), { withFileTypes: true })

  for (const entry of entries) {
    if (entry.name === "@sixb" || entry.name === "create-sixb") continue

    const source = await realpath(join(repoRoot, "node_modules", entry.name))
    await symlink(source, join(nodeModulesDir, entry.name))
  }
}

async function readManifest(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson
}

/** Every `./…` path the manifest promises, from `main`, `types`, `bin`, and `exports`. */
function declaredTargets(manifest: PackageJson): string[] {
  const targets = new Set<string>()
  addTarget(manifest.main, targets)
  addTarget(manifest.types, targets)

  if (typeof manifest.bin === "string") addTarget(manifest.bin, targets)
  else for (const target of Object.values(manifest.bin ?? {})) addTarget(target, targets)

  collectExportTargets(manifest.exports, targets)
  return [...targets].sort((a, b) => a.localeCompare(b))
}

function collectExportTargets(target: ExportTarget | undefined, targets: Set<string>): void {
  if (!target) return
  if (typeof target === "string") {
    addTarget(target, targets)
    return
  }
  if (Array.isArray(target)) {
    for (const item of target) collectExportTargets(item, targets)
    return
  }
  for (const item of Object.values(target)) collectExportTargets(item, targets)
}

function addTarget(target: string | undefined, targets: Set<string>): void {
  if (target?.startsWith("./")) targets.add(target)
}

/** Subpath specifiers a consumer can import, skipping wildcards, which need a concrete name. */
function importableSubpaths(pkg: ExtractedPackage): string[] {
  const exportsMap = pkg.manifest.exports
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return [pkg.name]

  return Object.keys(exportsMap)
    .filter((subpath) => subpath.startsWith(".") && !subpath.includes("*"))
    .filter((subpath) => !subpath.endsWith(".css"))
    .map((subpath) => (subpath === "." ? pkg.name : `${pkg.name}${subpath.slice(1)}`))
}

function matchesPackedFile(target: string, packedFiles: readonly string[]): boolean {
  return expandTarget(target, packedFiles).length > 0
}

/** The packed files a target names: itself, or every file a wildcard target matches. */
function expandTarget(target: string, packedFiles: readonly string[]): string[] {
  const path = target.slice(2)
  if (!path.includes("*")) return packedFiles.includes(path) ? [path] : []

  const pattern = new RegExp(
    `^${path
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
  )
  return packedFiles.filter((packedFile) => pattern.test(packedFile))
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(join(directory, entry.name), relativePath)))
      continue
    }
    files.push(relativePath)
  }

  return files
}

function packPackage(packageDir: string, destination: string): string {
  const result = Bun.spawnSync(
    [process.execPath, "pm", "pack", "--destination", destination, "--quiet"],
    { cwd: packageDir, stdout: "pipe", stderr: "pipe" }
  )
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pack ${packageDir}:\n${stdout}${stderr}`)
  }

  const tarball = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.endsWith(".tgz"))
  if (!tarball) throw new Error(`Pack output did not contain a tarball path:\n${stdout}${stderr}`)
  return resolve(dirname(packageDir), tarball)
}

function extractPackage(tarball: string, destination: string): void {
  const result = Bun.spawnSync(
    ["tar", "-xzf", tarball, "--strip-components=1", "-C", destination],
    { stdout: "pipe", stderr: "pipe" }
  )
  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract ${tarball}:\n${result.stderr.toString()}`)
  }
}
