import { readdir } from "node:fs/promises"
import { join } from "node:path"

type PackageJson = {
  name?: string
  private?: boolean
  main?: string
  types?: string
  exports?: unknown
  files?: string[]
  license?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
}

const root = process.cwd()
const workspaceRoots = ["auth", "packages", "connectors", "broker", "queues", "storage"]
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

  if (!packageJson.main?.startsWith("./dist/")) {
    throw new Error(`[SixbPublish] ${name} must publish main from ./dist/.`)
  }

  if (!packageJson.types?.startsWith("./dist/")) {
    throw new Error(`[SixbPublish] ${name} must publish types from ./dist/.`)
  }

  if (!packageJson.exports) {
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
    if (version.startsWith("workspace:") && !dependency.startsWith("@sixb/")) {
      throw new Error(`[SixbPublish] ${name} has non-Sixb workspace dependency ${dependency}.`)
    }
  }
}

async function dryRunPack(packageInfo: { dir: string; packageJson: PackageJson }): Promise<void> {
  const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--quiet"], {
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

  if (stdout.includes("/tests/") || stdout.includes("package/tests/")) {
    throw new Error(`[SixbPublish] ${packageName(packageInfo)} pack output includes tests.`)
  }
}

function packageName(packageInfo: { dir: string; packageJson: PackageJson }): string {
  return packageInfo.packageJson.name ?? packageInfo.dir
}
