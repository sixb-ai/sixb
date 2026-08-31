import type { PublishablePackage } from "./publishable-packages"
import { packageName } from "./publishable-packages"
import type { PackageRegistryState, PlannedPackageRelease } from "./release-plan"
import { packageReleaseId } from "./release-plan"
import { isPreviewRelease } from "./release-policy"

export interface PackagePromotionPlan {
  readonly promote: readonly PlannedPackageRelease[]
  readonly alreadyPromoted: number
}

/**
 * Build the complete promotion plan before changing the first dist-tag.
 *
 * Every local version must already exist. A package either already has the target tag or must be
 * staged under the source tag. This makes partial publication and stale local manifests fail before
 * a promotion can leave the registry in a mixed state.
 */
export function createPackagePromotionPlan(
  ordered: readonly PublishablePackage[],
  registryByName: ReadonlyMap<string, PackageRegistryState>,
  sourceTag: string,
  targetTag: string
): PackagePromotionPlan {
  if (sourceTag === targetTag) {
    throw new Error(`[SixbPromote] Source and target tags are both "${sourceTag}".`)
  }

  const promote: PlannedPackageRelease[] = []

  for (const packageInfo of ordered) {
    const name = packageName(packageInfo)
    const version = packageInfo.packageJson.version
    if (!version?.trim()) throw new Error(`[SixbPromote] ${name} has no version.`)

    const registry = registryByName.get(name)
    if (!registry) throw new Error(`[SixbPromote] Registry state is missing for ${name}.`)
    if (!registry.versions.has(version)) {
      throw new Error(
        `[SixbPromote] ${name}@${version} is not published. Complete the staged publication first.`
      )
    }

    const release = { packageInfo, name, version }
    if (registry.tags[targetTag] === version) continue
    if (isPreviewRelease(version)) {
      throw new Error(
        `[SixbPromote] ${packageReleaseId(release)} is a preview and cannot move "${targetTag}".`
      )
    }
    if (registry.tags[sourceTag] !== version) {
      throw new Error(
        `[SixbPromote] ${packageReleaseId(release)} is not staged under "${sourceTag}" ` +
          `(found ${registry.tags[sourceTag] ?? "no tag"}).`
      )
    }

    const currentTarget = registry.tags[targetTag]
    if (currentTarget && Bun.semver.order(version, currentTarget) < 0) {
      throw new Error(
        `[SixbPromote] ${packageReleaseId(release)} would move "${targetTag}" backwards ` +
          `from ${currentTarget}.`
      )
    }
    promote.push(release)
  }

  return { promote, alreadyPromoted: ordered.length - promote.length }
}
