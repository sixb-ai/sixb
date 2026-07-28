import { readdir } from "node:fs/promises"
import { join } from "node:path"

type PackageJson = {
  name?: string
  private?: boolean
  main?: string
  types?: string
  exports?: ExportTarget
  bin?: string | Record<string, string>
  files?: string[]
  license?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
}

type ExportTarget = string | null | ExportTarget[] | { [condition: string]: ExportTarget }

const root = process.cwd()
const workspaceRoots = [
  "auth",
  "packages",
  "connectors",
  "broker",
  "loggers",
  "queues",
  "sandboxes",
  "storage",
]
const packages = await discoverPublishablePackages()

for (const packageInfo of packages) {
  validatePackage(packageInfo)
  await dryRunPack(packageInfo)
}

console.log(`[SixbPublish] Verified ${packages.length} publishable packages.`)

async function discoverPublishablePackages(): Promise<
  Array<{ dir: string; packageJson: PackageJson }>
> {
  const found: Array<{ dir: string; packageJson: PackageJson }> = []

  for (const workspaceRoot of workspaceRoots) {
    const entries = await readdir(join(root, workspaceRoot), { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dir = join(workspaceRoot, entry.name)
      const packageJsonPath = join(root, dir, "package.json")
      const packageJsonFile = Bun.file(packageJsonPath)
      if (!(await packageJsonFile.exists())) continue

      const packageJson = (await packageJsonFile.json()) as PackageJson
      if (packageJson.private) continue

      found.push({ dir, packageJson })
    }
  }

  return found.sort((a, b) => packageName(a).localeCompare(packageName(b)))
}

function validatePackage(packageInfo: { dir: string; packageJson: PackageJson }): void {
  const name = packageName(packageInfo)
  const { packageJson } = packageInfo

  // Command packages can expose supported utility subpaths without exposing an
  // importable package root. They do not need root main/types entries.
  const commandOnly = Boolean(packageJson.bin) && !hasRootExport(packageJson.exports)

  if (!commandOnly && !packageJson.main?.startsWith("./dist/")) {
    throw new Error(`[SixbPublish] ${name} must publish main from ./dist/.`)
  }

  if (!commandOnly && !packageJson.types?.startsWith("./dist/")) {
    throw new Error(`[SixbPublish] ${name} must publish types from ./dist/.`)
  }

  if (!commandOnly && !packageJson.exports) {
    throw new Error(`[SixbPublish] ${name} must define package exports.`)
  }

  if (!packageJson.files?.includes("dist")) {
    throw new Error(`[SixbPublish] ${name} must whitelist dist in files.`)
  }

  if (packageJson.license !== "MIT") {
    throw new Error(`[SixbPublish] ${name} must declare the MIT license.`)
  }

  if (packageJson.publishConfig?.access !== "public") {
    throw new Error(`[SixbPublish] ${name} must set publishConfig.access to public.`)
  }

  for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
    const isSixbWorkspaceDependency =
      dependency.startsWith("@sixb/") || dependency === "create-sixb"
    if (version.startsWith("workspace:") && !isSixbWorkspaceDependency) {
      throw new Error(`[SixbPublish] ${name} has non-Sixb workspace dependency ${dependency}.`)
    }
  }
}

function hasRootExport(exports: unknown): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return true
  if (!exports || typeof exports !== "object") return false

  const keys = Object.keys(exports)
  return keys.includes(".") || keys.every((key) => !key.startsWith("."))
}

async function dryRunPack(packageInfo: { dir: string; packageJson: PackageJson }): Promise<void> {
  const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run"], {
    cwd: join(root, packageInfo.dir),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    throw new Error(
      `[SixbPublish] Failed to pack ${packageName(packageInfo)}.\n${stdout}${stderr}`.trim()
    )
  }

  const packedPaths = parsePackedPaths(`${stdout}\n${stderr}`)
  if (packedPaths.size === 0) {
    throw new Error(`[SixbPublish] ${packageName(packageInfo)} pack output listed no files.`)
  }

  if ([...packedPaths].some((path) => path.split("/").includes("tests"))) {
    throw new Error(`[SixbPublish] ${packageName(packageInfo)} pack output includes tests.`)
  }

  for (const target of packageTargets(packageInfo.packageJson)) {
    if (!targetIsPacked(target, packedPaths)) {
      throw new Error(
        `[SixbPublish] ${packageName(packageInfo)} target ${target} is missing from the tarball.`
      )
    }
  }
}

function parsePackedPaths(output: string): Set<string> {
  const paths = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^packed\s+\S+\s+(.+)$/)
    if (match?.[1]) paths.add(match[1])
  }
  return paths
}

function packageTargets(packageJson: PackageJson): string[] {
  const targets = new Set<string>()
  addPackageTarget(packageJson.main, targets)
  addPackageTarget(packageJson.types, targets)

  if (typeof packageJson.bin === "string") {
    addPackageTarget(packageJson.bin, targets)
  } else {
    for (const target of Object.values(packageJson.bin ?? {})) {
      addPackageTarget(target, targets)
    }
  }

  collectExportTargets(packageJson.exports, targets)
  return [...targets].sort((a, b) => a.localeCompare(b))
}

function collectExportTargets(target: ExportTarget | undefined, targets: Set<string>): void {
  if (!target) return
  if (typeof target === "string") {
    addPackageTarget(target, targets)
    return
  }
  if (Array.isArray(target)) {
    for (const item of target) collectExportTargets(item, targets)
    return
  }
  for (const item of Object.values(target)) collectExportTargets(item, targets)
}

function addPackageTarget(target: string | undefined, targets: Set<string>): void {
  if (target?.startsWith("./")) targets.add(target)
}

function targetIsPacked(target: string, packedPaths: Set<string>): boolean {
  const path = target.slice(2)
  if (!path.includes("*")) return packedPaths.has(path)

  const pattern = new RegExp(
    `^${path
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`
  )
  return [...packedPaths].some((packedPath) => pattern.test(packedPath))
}

function packageName(packageInfo: { dir: string; packageJson: PackageJson }): string {
  return packageInfo.packageJson.name ?? packageInfo.dir
}
