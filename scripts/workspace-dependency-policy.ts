import { join } from "node:path"
import type { PackageJson, PublishablePackage } from "./publishable-packages"
import { packageName } from "./publishable-packages"

export const exactWorkspaceProtocol = "workspace:*" as const
export const compatibleWorkspaceProtocol = "workspace:^" as const

export type WorkspaceProtocol = typeof exactWorkspaceProtocol | typeof compatibleWorkspaceProtocol

export type ShippedDependencyField = "dependencies" | "peerDependencies" | "optionalDependencies"

export interface WorkspaceDependencyExpectation {
  readonly field: "dependencies" | "peerDependencies"
  readonly protocol: WorkspaceProtocol
}

export interface WorkspaceDependencyEntry {
  readonly dependency: string
  readonly field: ShippedDependencyField
  readonly range: string
}

/**
 * Packages that consume `@sixb/core/internal/*` as companions to a host core runtime.
 *
 * They peer exactly on core so an installer cannot quietly put a second core underneath a worker,
 * server, or storage provider. The CLI is the host and therefore keeps core in `dependencies`.
 */
export const coreInternalCompanions: ReadonlySet<string> = new Set([
  "@sixb/action-worker",
  "@sixb/agent-worker",
  "@sixb/orchestrator",
  "@sixb/pg",
  "@sixb/pipeline-worker",
  "@sixb/projection-worker",
  "@sixb/rules-worker",
  "@sixb/server",
  "@sixb/sqlite",
  "@sixb/sync-worker",
  "@sixb/workflow-worker",
])

export const coreInternalConsumers: ReadonlySet<string> = new Set([
  ...coreInternalCompanions,
  "@sixb/cli",
])

const extensionRoots = new Set([
  "auth",
  "broker",
  "connectors",
  "loggers",
  "queues",
  "sandboxes",
  "storage",
])

/** The internal companions the CLI constructs around its own exact core runtime. */
const cliRuntimeCompanions = new Set(
  [...coreInternalCompanions].filter((name) => name !== "@sixb/pg" && name !== "@sixb/sqlite")
)

/**
 * One policy for every shipped workspace edge.
 *
 * Public APIs use caret ranges. Extensions peer on the host core. Consumers of core internals use
 * exact peers, while the CLI owns core and pins the internal companions it constructs.
 */
export function expectedWorkspaceDependency(
  packageInfo: PublishablePackage,
  dependency: string
): WorkspaceDependencyExpectation {
  const name = packageName(packageInfo)

  if (name === "@sixb/cli") {
    return {
      field: "dependencies",
      protocol:
        dependency === "@sixb/core" || cliRuntimeCompanions.has(dependency)
          ? exactWorkspaceProtocol
          : compatibleWorkspaceProtocol,
    }
  }

  if (dependency === "@sixb/core") {
    if (coreInternalCompanions.has(name)) {
      return { field: "peerDependencies", protocol: exactWorkspaceProtocol }
    }

    if (extensionRoots.has(packageInfo.dir.split("/")[0] ?? "")) {
      return { field: "peerDependencies", protocol: compatibleWorkspaceProtocol }
    }
  }

  return { field: "dependencies", protocol: compatibleWorkspaceProtocol }
}

export function workspaceDependencyEntries(packageJson: PackageJson): WorkspaceDependencyEntry[] {
  const entries: WorkspaceDependencyEntry[] = []

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [dependency, range] of Object.entries(packageJson[field] ?? {})) {
      if (dependency.startsWith("@sixb/") || dependency === "create-sixb") {
        entries.push({ dependency, field, range })
      }
    }
  }

  return entries
}

export function workspaceDependencyPolicyErrors(packageInfo: PublishablePackage): string[] {
  const name = packageName(packageInfo)
  const errors: string[] = []
  const byDependency = new Map<string, WorkspaceDependencyEntry[]>()

  for (const entry of workspaceDependencyEntries(packageInfo.packageJson)) {
    const entries = byDependency.get(entry.dependency) ?? []
    entries.push(entry)
    byDependency.set(entry.dependency, entries)
  }

  for (const [dependency, entries] of byDependency) {
    const expected = expectedWorkspaceDependency(packageInfo, dependency)

    if (entries.length !== 1) {
      errors.push(`${name} declares ${dependency} in more than one shipped dependency field.`)
      continue
    }

    const [entry] = entries
    if (!entry) continue

    if (entry.field !== expected.field || entry.range !== expected.protocol) {
      errors.push(
        `${name} must declare ${dependency} as ${expected.field}.${dependency} ` +
          `${expected.protocol} (found ${entry.field}.${dependency} ${entry.range}).`
      )
    }

    if (expected.field === "peerDependencies") {
      const devRange = packageInfo.packageJson.devDependencies?.[dependency]
      if (devRange !== exactWorkspaceProtocol) {
        errors.push(
          `${name} must develop against ${dependency} as devDependencies.${dependency} ` +
            `${exactWorkspaceProtocol} (found ${devRange ?? "nothing"}).`
        )
      }
    }
  }

  return errors
}

/**
 * Keep the explicit compatibility cohort honest in both directions.
 *
 * A plain source scan is deliberate: type-only internal imports are compatibility dependencies too,
 * while Bun's transpiler correctly erases them from its runtime import scan.
 */
export async function coreInternalConsumerErrors(
  root: string,
  packages: readonly PublishablePackage[]
): Promise<string[]> {
  const errors: string[] = []

  for (const packageInfo of packages) {
    const name = packageName(packageInfo)
    if (name === "@sixb/core") continue

    let importsCoreInternal = false
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx,js,jsx,mjs,cjs}").scan({
      cwd: join(root, packageInfo.dir),
    })) {
      const contents = await Bun.file(join(root, packageInfo.dir, file)).text()
      if (contents.includes("@sixb/core/internal/")) {
        importsCoreInternal = true
        break
      }
    }

    if (importsCoreInternal && !coreInternalConsumers.has(name)) {
      errors.push(`${name} imports @sixb/core/internal/* but is not an exact core consumer.`)
    }
    if (!importsCoreInternal && coreInternalConsumers.has(name)) {
      errors.push(`${name} is an exact core consumer but no longer imports @sixb/core/internal/*.`)
    }
  }

  return errors
}
