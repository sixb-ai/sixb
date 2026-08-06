import type { PublishablePackage } from "./publishable-packages"
import { internalDependencies, packageName } from "./publishable-packages"

export interface PackageRegistryState {
  readonly versions: ReadonlySet<string>
  readonly tags: Readonly<Record<string, string>>
}

export interface PlannedPackageRelease {
  readonly packageInfo: PublishablePackage
  readonly name: string
  readonly version: string
}

export interface PackageReleasePlan {
  readonly publish: readonly PlannedPackageRelease[]
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
      publish.push(release)
      continue
    }

    if (tag !== "latest" && registry.tags[tag] === version && registry.tags.latest !== version) {
      stagedForPromotion.push(release)
    }
  }

  assertInternalDependenciesAvailable(ordered, publish, registryByName)

  return {
    publish,
    stagedForPromotion,
    alreadyPublished: ordered.length - publish.length,
  }
}

export function packageReleaseId(release: PlannedPackageRelease): string {
  return `${release.name}@${release.version}`
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
