import { readdir } from "node:fs/promises"
import { join } from "node:path"

export type ExportTarget = string | null | ExportTarget[] | { [condition: string]: ExportTarget }

export type PackageJson = {
  name?: string
  version?: string
  description?: string
  repository?: { directory?: string }
  private?: boolean
  main?: string
  types?: string
  exports?: ExportTarget
  bin?: string | Record<string, string>
  files?: string[]
  license?: string
  publishConfig?: { access?: string }
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export type DependencyField =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies"

/**
 * The fields a published package carries with it. `devDependencies` is not one: it never ships,
 * so it constrains neither the publish order nor what a consumer installs.
 */
const SHIPPED_DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly DependencyField[]

export interface PublishablePackage {
  readonly dir: string
  readonly packageJson: PackageJson
}

/**
 * Workspace roots that hold publishable packages. `apps/` and `examples/` are private by
 * convention, and `templates/` moved inside `packages/create-sixb`.
 */
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

/**
 * One answer to "what do we publish", shared by the release gate and the publish script so they
 * can never disagree about which packages exist.
 */
export async function discoverPublishablePackages(root: string): Promise<PublishablePackage[]> {
  const found: PublishablePackage[] = []

  for (const workspaceRoot of workspaceRoots) {
    const entries = await readdir(join(root, workspaceRoot), { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const dir = join(workspaceRoot, entry.name)
      const packageJsonFile = Bun.file(join(root, dir, "package.json"))
      if (!(await packageJsonFile.exists())) continue

      const packageJson = (await packageJsonFile.json()) as PackageJson
      if (packageJson.private) continue

      found.push({ dir, packageJson })
    }
  }

  return found.sort((a, b) => packageName(a).localeCompare(packageName(b)))
}

export function packageName(packageInfo: PublishablePackage): string {
  return packageInfo.packageJson.name ?? packageInfo.dir
}

/**
 * Names of the sibling workspace packages this one depends on. Defaults to the fields that ship,
 * which is what publishing has to order. Pass `fields` to ask a different question: what a package
 * is *built* from includes its `devDependencies`.
 */
export function internalDependencies(
  packageJson: PackageJson,
  fields: readonly DependencyField[] = SHIPPED_DEPENDENCY_FIELDS
): Set<string> {
  const names = new Set<string>()

  for (const field of fields) {
    for (const dependency of Object.keys(packageJson[field] ?? {})) {
      if (dependency.startsWith("@sixb/") || dependency === "create-sixb") names.add(dependency)
    }
  }

  return names
}

/**
 * Order packages so each one is published only after everything it depends on.
 *
 * `bun pm pack` rewrites a `workspace:*` range to the exact version, so publishing a package before
 * its dependency means the registry briefly holds a package whose dependency does not resolve.
 * Alphabetical order within a wave keeps runs comparable.
 */
export function topologicalPublishOrder(packages: PublishablePackage[]): PublishablePackage[] {
  const byName = new Map(packages.map((packageInfo) => [packageName(packageInfo), packageInfo]))
  const pending = new Map(
    packages.map((packageInfo) => [
      packageName(packageInfo),
      new Set(
        [...internalDependencies(packageInfo.packageJson)].filter((name) => byName.has(name))
      ),
    ])
  )

  const ordered: PublishablePackage[] = []
  while (pending.size > 0) {
    const ready = [...pending.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b))

    if (ready.length === 0) {
      throw new Error(
        `[SixbPublish] Dependency cycle among publishable packages: ${[...pending.keys()].sort().join(", ")}`
      )
    }

    for (const name of ready) {
      const packageInfo = byName.get(name)
      if (packageInfo) ordered.push(packageInfo)
      pending.delete(name)
    }
    for (const dependencies of pending.values()) {
      for (const name of ready) dependencies.delete(name)
    }
  }

  return ordered
}
