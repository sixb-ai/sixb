import type { PublishablePackage } from "./publishable-packages"
import { internalDependencies, packageName } from "./publishable-packages"
import {
  compatibleWorkspaceProtocol,
  exactWorkspaceProtocol,
  type ShippedDependencyField,
  workspaceDependencyEntries,
} from "./workspace-dependency-policy"

export interface PublishedPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

export interface PackageRegistryState {
  readonly versions: ReadonlyMap<string, PublishedPackageManifest>
  readonly tags: Readonly<Record<string, string>>
}

export interface PlannedPackageRelease {
  readonly packageInfo: PublishablePackage
  readonly name: string
  readonly version: string
}

export interface PackageReleasePlan {
  readonly publish: readonly PlannedPackageRelease[]
  readonly deferredInitial: readonly PlannedPackageRelease[]
  readonly stagedForPromotion: readonly PlannedPackageRelease[]
  readonly alreadyPublished: number
}

/**
 * A manifest version is the package's release intent. Missing registry versions are published;
 * versions already present are left alone so unrelated packages can stay on their current line.
 */
export function createPackageReleasePlan(
  ordered: readonly PublishablePackage[],
  registryByName: ReadonlyMap<string, PackageRegistryState>,
  tag: string
): PackageReleasePlan {
  const publish: PlannedPackageRelease[] = []
  const deferredInitial: PlannedPackageRelease[] = []
  const stagedForPromotion: PlannedPackageRelease[] = []

  for (const packageInfo of ordered) {
    const name = packageName(packageInfo)
    const version = packageInfo.packageJson.version
    if (!version?.trim()) {
      throw new Error(`[SixbPublish] ${name} has no version.`)
    }

    const registry = registryByName.get(name)
    if (!registry) {
      throw new Error(`[SixbPublish] Registry state is missing for ${name}.`)
    }

    const release = { packageInfo, name, version }
    if (!registry.versions.has(version)) {
      assertReleaseAdvancesTags(release, registry, tag)
      if (registry.versions.size === 0 && tag !== "latest") {
        deferredInitial.push(release)
        continue
      }
      publish.push(release)
      continue
    }

    if (tag !== "latest" && registry.tags[tag] === version && registry.tags.latest !== version) {
      assertReleaseAdvancesTags(release, registry, tag)
      stagedForPromotion.push(release)
    }
  }

  assertPublishedWorkspaceDependenciesCompatible(ordered, registryByName)
  assertInternalDependenciesAvailable(ordered, publish, registryByName)

  return {
    publish,
    deferredInitial,
    stagedForPromotion,
    alreadyPublished: ordered.length - publish.length - deferredInitial.length,
  }
}

export function packageReleaseId(release: PlannedPackageRelease): string {
  return `${release.name}@${release.version}`
}

/**
 * An existing package version is immutable, but a workspace protocol is resolved from today's
 * sibling version every time Bun packs it. Compare the published requirement with the current
 * workspace before skipping that package.
 *
 * Exact edges must still name today's sibling exactly. Compatible edges may keep an older caret
 * floor as long as it remains in range; that is what lets public packages release independently.
 */
function assertPublishedWorkspaceDependenciesCompatible(
  ordered: readonly PublishablePackage[],
  registryByName: ReadonlyMap<string, PackageRegistryState>
): void {
  const byName = new Map(ordered.map((packageInfo) => [packageName(packageInfo), packageInfo]))

  for (const packageInfo of ordered) {
    const name = packageName(packageInfo)
    const version = packageInfo.packageJson.version
    if (!version) continue

    const published = registryByName.get(name)?.versions.get(version)
    if (!published) continue

    const localEntries = workspaceDependencyEntries(packageInfo.packageJson)
    const dependencies = new Set([
      ...localEntries.map((entry) => entry.dependency),
      ...publishedDependencyNames(published).filter((dependency) => byName.has(dependency)),
    ])

    for (const dependencyName of dependencies) {
      const localMatches = localEntries.filter((entry) => entry.dependency === dependencyName)
      const entry = localMatches.length === 1 ? localMatches[0] : undefined
      const dependency = byName.get(dependencyName)
      const dependencyVersion = dependency?.packageJson.version
      if (!dependency || !dependencyVersion?.trim()) {
        throw new Error(
          `[SixbPublish] ${name}@${version} depends on unpublished workspace package ${dependencyName}.`
        )
      }

      const publishedEntries = publishedDependencyEntries(published, dependencyName)
      const publishedEntry = publishedEntries.length === 1 ? publishedEntries[0] : undefined
      const compatible =
        entry !== undefined &&
        publishedEntry?.field === entry.field &&
        publishedRangeAccepts(entry.range, publishedEntry.range, dependencyVersion)

      if (compatible) continue

      const actual =
        publishedEntries.length === 0
          ? "nothing"
          : publishedEntries.map(({ field, range }) => `${field} ${range}`).join(" and ")
      const expected = entry
        ? `${entry.field} ${
            entry.range === exactWorkspaceProtocol ? dependencyVersion : `^${dependencyVersion}`
          }`
        : "nothing"
      throw new Error(
        `[SixbPublish] ${name}@${version} is already published with ` +
          `${dependencyName} as ${actual}, but the workspace requires ${expected}. ` +
          `Bump ${name} before publishing this workspace.`
      )
    }
  }
}

/**
 * Publishing writes the requested dist-tag, and every stable staged release is then offered for
 * promotion to `latest`. Neither pointer may move backwards: doing so silently changes what a new
 * install receives even though every package version is immutable.
 */
function assertReleaseAdvancesTags(
  release: PlannedPackageRelease,
  registry: PackageRegistryState,
  tag: string
): void {
  const targets = new Map<string, string>()
  const taggedVersion = registry.tags[tag]
  if (taggedVersion) targets.set(tag, taggedVersion)

  const latestVersion = registry.tags.latest
  if (latestVersion) targets.set("latest", latestVersion)

  for (const [targetTag, currentVersion] of targets) {
    if (Bun.semver.order(release.version, currentVersion) >= 0) continue

    throw new Error(
      `[SixbPublish] ${packageReleaseId(release)} would move the "${targetTag}" tag backwards ` +
        `from ${currentVersion}. Bump ${release.name} above ${currentVersion}, or leave its ` +
        "manifest on the already-published version."
    )
  }
}

function publishedDependencyNames(manifest: PublishedPackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]
}

function publishedDependencyEntries(
  manifest: PublishedPackageManifest,
  dependency: string
): Array<{ field: ShippedDependencyField; range: string }> {
  const entries: Array<{ field: ShippedDependencyField; range: string }> = []

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const range = manifest[field]?.[dependency]
    if (range) entries.push({ field, range })
  }

  return entries
}

function publishedRangeAccepts(
  workspaceRange: string,
  publishedRange: string,
  dependencyVersion: string
): boolean {
  if (workspaceRange === exactWorkspaceProtocol) return publishedRange === dependencyVersion
  if (workspaceRange === compatibleWorkspaceProtocol) {
    return publishedRange.startsWith("^") && Bun.semver.satisfies(dependencyVersion, publishedRange)
  }
  throw new Error(
    `[SixbPublish] Unsupported workspace dependency protocol ${workspaceRange}; ` +
      `expected ${exactWorkspaceProtocol} or ${compatibleWorkspaceProtocol}.`
  )
}

function assertInternalDependenciesAvailable(
  ordered: readonly PublishablePackage[],
  publish: readonly PlannedPackageRelease[],
  registryByName: ReadonlyMap<string, PackageRegistryState>
): void {
  const byName = new Map(ordered.map((packageInfo) => [packageName(packageInfo), packageInfo]))
  const available = new Set<string>()

  for (const packageInfo of ordered) {
    const name = packageName(packageInfo)
    const version = packageInfo.packageJson.version
    if (version && registryByName.get(name)?.versions.has(version)) {
      available.add(`${name}@${version}`)
    }
  }

  for (const release of publish) {
    for (const dependencyName of internalDependencies(release.packageInfo.packageJson)) {
      const dependency = byName.get(dependencyName)
      if (!dependency) {
        throw new Error(
          `[SixbPublish] ${packageReleaseId(release)} depends on unpublished workspace package ${dependencyName}.`
        )
      }

      const dependencyVersion = dependency.packageJson.version
      if (!dependencyVersion?.trim()) {
        throw new Error(`[SixbPublish] ${dependencyName} has no version.`)
      }

      const dependencyId = `${dependencyName}@${dependencyVersion}`
      if (!available.has(dependencyId)) {
        throw new Error(
          `[SixbPublish] ${packageReleaseId(release)} requires ${dependencyId} before it can publish.`
        )
      }
    }
    available.add(packageReleaseId(release))
  }
}
