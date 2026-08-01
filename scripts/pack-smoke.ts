import { join } from "node:path"
import { artifactScope, findUndeclaredImports, sourceScope } from "./package-boundaries"
import {
  discoverPublishablePackages,
  type ExportTarget,
  type PackageJson,
  type PublishablePackage,
  packageName,
  topologicalPublishOrder,
} from "./publishable-packages"

const root = process.cwd()
const packages = await discoverPublishablePackages(root)

assertLockstepVersions(packages)

// A cycle makes the release unpublishable, because a package cannot go to the registry before
// something it depends on. Failing here beats finding out halfway through a publish run.
topologicalPublishOrder(packages)

for (const packageInfo of packages) {
  validatePackage(packageInfo)
  await assertImportsAreDeclared(packageInfo)
  await dryRunPack(packageInfo)
}

console.log(`[SixbPublish] Verified ${packages.length} publishable packages.`)

/**
 * Every package ships on one train. A stray version means a `workspace:*` dependency resolves to
 * a version its sibling never published, which only shows up as an install failure downstream.
 */
function assertLockstepVersions(all: PublishablePackage[]): void {
  const byVersion = new Map<string, string[]>()
  for (const packageInfo of all) {
    const version = packageInfo.packageJson.version
    if (!version) {
      throw new Error(`[SixbPublish] ${packageName(packageInfo)} has no version.`)
    }
    byVersion.set(version, [...(byVersion.get(version) ?? []), packageName(packageInfo)])
  }

  if (byVersion.size <= 1) return

  const detail = [...byVersion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([version, names]) => `  ${version}: ${names.join(", ")}`)
    .join("\n")
  throw new Error(`[SixbPublish] Publishable packages must share one version.\n${detail}`)
}

function validatePackage(packageInfo: PublishablePackage): void {
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

  // npm renders these on the package page, and an empty one reads as abandoned.
  if (!packageJson.description?.trim()) {
    throw new Error(`[SixbPublish] ${name} must declare a description.`)
  }

  if (packageJson.repository?.directory !== packageInfo.dir) {
    throw new Error(
      `[SixbPublish] ${name} must set repository.directory to ${packageInfo.dir} ` +
        `(found ${packageJson.repository?.directory ?? "nothing"}).`
    )
  }

  for (const required of ["README.md", "LICENSE"]) {
    if (!packageJson.files?.includes(required)) {
      throw new Error(`[SixbPublish] ${name} must whitelist ${required} in files.`)
    }
  }

  assertOnlyBunReadsSource(name, packageJson.exports)

  // A `workspace:` range is rewritten to the exact version at pack time. Anywhere it is *not*
  // rewritten, a literal "workspace:*" ships and the install fails for the consumer — so every
  // dependency field has to be checked, not just `dependencies`.
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [dependency, range] of Object.entries(packageJson[field] ?? {})) {
      const isSixbWorkspace = dependency.startsWith("@sixb/") || dependency === "create-sixb"
      if (range.startsWith("workspace:") && !isSixbWorkspace) {
        throw new Error(
          `[SixbPublish] ${name} has non-Sixb workspace dependency ${dependency} in ${field}.`
        )
      }
      if (isSixbWorkspace && range !== "workspace:*") {
        throw new Error(
          `[SixbPublish] ${name} must depend on ${dependency} as workspace:* in ${field} ` +
            `(found ${range}).`
        )
      }
    }
  }
}

/**
 * Only the `bun` condition may resolve TypeScript out of `src`.
 *
 * Bun runs TypeScript directly, which is why `bun` points at source and consumers get real stack
 * traces. Every other condition is read by something that does not compile `node_modules` — a web
 * bundler, Node, `tsc` — so pointing one at `./src/*.ts` is a hard failure for that consumer. Four
 * `browser` conditions in `@sixb/core` shipped exactly that. Non-TypeScript assets such as
 * `globals.css` are fine to serve from source; bundlers handle those.
 */
function assertOnlyBunReadsSource(name: string, exports: ExportTarget | undefined): void {
  const offenders: string[] = []
  visitExportTargets(exports, [], (conditions, target) => {
    if (!target.startsWith("./src/") || !/\.tsx?$/.test(target)) return
    if (conditions.at(-1) === "bun") return
    offenders.push(`${conditions.join(".") || "(unconditional)"} -> ${target}`)
  })

  if (offenders.length > 0) {
    throw new Error(
      `[SixbPublish] ${name} serves TypeScript source to a non-Bun consumer:\n  ${offenders.join("\n  ")}`
    )
  }
}

function visitExportTargets(
  target: ExportTarget | undefined,
  conditions: string[],
  visit: (conditions: string[], target: string) => void
): void {
  if (!target) return
  if (typeof target === "string") {
    visit(conditions, target)
    return
  }
  if (Array.isArray(target)) {
    for (const item of target) visitExportTargets(item, conditions, visit)
    return
  }
  for (const [condition, value] of Object.entries(target)) {
    // Subpath keys (".", "./x") are not conditions; only nested keys are.
    visitExportTargets(
      value,
      condition.startsWith(".") ? conditions : [...conditions, condition],
      visit
    )
  }
}

function hasRootExport(exports: unknown): boolean {
  if (typeof exports === "string" || Array.isArray(exports)) return true
  if (!exports || typeof exports !== "object") return false

  const keys = Object.keys(exports)
  return keys.includes(".") || keys.every((key) => !key.startsWith("."))
}

/**
 * A package may only import what it declares.
 *
 * This is the assertion that does not depend on how the build happens to resolve things. A bundler
 * that absorbs a sibling instead of leaving it external emits that sibling's third-party imports
 * from the wrong package, and they show up here as names this manifest never promised — which is
 * also how a plainly forgotten dependency shows up. `tsc` cannot see either one: the root
 * `tsconfig.json` maps every `@sixb/*` specifier to source, so an undeclared sibling type-checks.
 *
 * Both directions matter. `dist` is what non-Bun consumers load; `src` ships in the tarball and
 * `exports.bun` points Bun consumers straight at it.
 */
async function assertImportsAreDeclared(packageInfo: PublishablePackage): Promise<void> {
  const name = packageName(packageInfo)
  const packageRoot = join(root, packageInfo.dir)

  for (const scope of [sourceScope, artifactScope]) {
    const undeclared = await findUndeclaredImports(packageRoot, packageInfo.packageJson, scope)
    if (undeclared.length === 0) continue

    const detail = undeclared
      .map(({ specifier, file }) => `  ${specifier} (${scope.directory}/${file})`)
      .join("\n")
    throw new Error(
      `[SixbPublish] ${name} imports packages it does not declare:\n${detail}\n` +
        "Declare them, or — when they belong to a sibling — check that the sibling is a declared " +
        "workspace dependency so the build keeps it external instead of absorbing its source."
    )
  }
}

async function dryRunPack(packageInfo: PublishablePackage): Promise<void> {
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
