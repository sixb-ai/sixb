import type { PackageRegistryState, PublishedPackageManifest } from "./release-plan"

export const publicNpmRegistry = "https://registry.npmjs.org"

/** Read the complete package state before a release write. A 404 is an unpublished package. */
export async function readRegistryState(
  name: string,
  registryUrl: string = publicNpmRegistry
): Promise<PackageRegistryState> {
  const registry = registryUrl.replace(/\/+$/, "")
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    headers: {
      accept: "application/vnd.npm.install-v1+json",
      "cache-control": "no-cache",
    },
  })

  if (response.status === 404) return { versions: new Map(), tags: {} }
  if (!response.ok) {
    throw new Error(`[SixbRegistry] Could not query the registry for ${name}: ${response.status}`)
  }

  const body = (await response.json()) as {
    versions?: Record<string, unknown>
    "dist-tags"?: Record<string, string>
  }
  return {
    versions: new Map(
      Object.entries(body.versions ?? {}).map(([version, manifest]) => [
        version,
        publishedPackageManifest(manifest),
      ])
    ),
    tags: body["dist-tags"] ?? {},
  }
}

function publishedPackageManifest(value: unknown): PublishedPackageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}

  const manifest = value as Record<string, unknown>
  const dependencies = dependencyRecord(manifest.dependencies)
  const peerDependencies = dependencyRecord(manifest.peerDependencies)
  const optionalDependencies = dependencyRecord(manifest.optionalDependencies)

  return {
    ...(dependencies ? { dependencies } : {}),
    ...(peerDependencies ? { peerDependencies } : {}),
    ...(optionalDependencies ? { optionalDependencies } : {}),
  }
}

function dependencyRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined

  const entries = Object.entries(value)
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
    return undefined
  }
  return Object.fromEntries(entries)
}
