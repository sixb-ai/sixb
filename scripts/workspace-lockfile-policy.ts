import { join } from "node:path"
import type { PublishablePackage } from "./publishable-packages"
import { packageName } from "./publishable-packages"

/** Bun 1.3.14 packs workspace dependency versions from the lockfile, even after a manifest bump. */
export async function assertWorkspaceLockfileVersions(
  root: string,
  packages: readonly PublishablePackage[]
): Promise<void> {
  const lockfile: unknown = Bun.JSON5.parse(await Bun.file(join(root, "bun.lock")).text())
  if (!lockfile || typeof lockfile !== "object" || !("workspaces" in lockfile)) {
    throw new Error("[SixbPublish] bun.lock has no workspaces. Run `bun install --lockfile-only`.")
  }
  const workspaces = lockfile.workspaces
  const errors: string[] = []
  for (const packageInfo of packages) {
    const entry: unknown =
      workspaces && typeof workspaces === "object" && packageInfo.dir in workspaces
        ? Reflect.get(workspaces, packageInfo.dir)
        : undefined
    const version = entry && typeof entry === "object" && "version" in entry ? entry.version : null
    if (version !== packageInfo.packageJson.version) {
      errors.push(
        `${packageName(packageInfo)}: manifest ${packageInfo.packageJson.version}, lockfile ${version ?? "missing"}`
      )
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `[SixbPublish] Stale workspace versions in bun.lock:\n  ${errors.join("\n  ")}\n` +
        "Run `bun install --lockfile-only` and commit bun.lock before packing or publishing. " +
        "A frozen install does not refresh version-only workspace changes."
    )
  }
}
