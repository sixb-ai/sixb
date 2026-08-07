import type { PackageJson, PublishablePackage } from "./publishable-packages"
import { packageName } from "./publishable-packages"

/**
 * Keep the starter compatible with independently-versioned framework packages.
 *
 * Each template dependency owns its range. A single create-sixb version cannot represent a
 * workspace once public package lines diverge, so the release gate checks those ranges directly
 * against the versions it is about to publish.
 */
export function createSixbTemplateDependencyErrors(
  template: Pick<PackageJson, "dependencies">,
  packages: readonly PublishablePackage[]
): string[] {
  const byName = new Map(packages.map((packageInfo) => [packageName(packageInfo), packageInfo]))
  const errors: string[] = []

  for (const [dependency, range] of Object.entries(template.dependencies ?? {})) {
    if (!dependency.startsWith("@sixb/")) continue

    const packageInfo = byName.get(dependency)
    if (!packageInfo) {
      errors.push(`create-sixb declares unknown workspace package ${dependency}.`)
      continue
    }

    const version = packageInfo.packageJson.version
    if (!version?.trim()) {
      errors.push(`${dependency} has no version for the create-sixb template to target.`)
      continue
    }

    if (!Bun.semver.satisfies(version, range)) {
      errors.push(
        `create-sixb requires ${dependency} ${range}, which does not accept the workspace ` +
          `version ${version}. Update only that template range.`
      )
    }
  }

  return errors
}
