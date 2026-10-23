import { type Principal, principalsEqual } from "../../auth"
import type {
  ArtifactRecord,
  ArtifactStorage,
  ArtifactVersionRecord,
} from "../../storage/artifacts/types"
import { parseArtifactAddress } from "../address"
import { ARTIFACT_LIMITS } from "../limits"
import type { ArtifactReference } from "../references"
import { resolveArtifactAddress } from "../resolve"
import type { ArtifactWarning } from "../warnings"
import { invalidArtifact } from "./files"

/** An address a validator found in a version, before it is resolved. */
export type FoundReference = Omit<ArtifactReference, "resolvedVersion">

interface ReferenceContext {
  readonly projectId: string
  readonly storage: ArtifactStorage
  /** Whether an address may name this artifact: one whoever publishes can read. */
  readonly readable: (artifact: ArtifactRecord) => Promise<boolean>
  /** The artifact being published, which an address may not name. */
  readonly artifactId?: string
}

/**
 * Resolves every address a version uses against what its author can read, recording the version
 * each one resolved to. An address that resolves to nothing refuses the version, saying where it
 * is and what the target has instead.
 */
export async function resolveReferences(
  context: ReferenceContext,
  found: readonly FoundReference[]
): Promise<ArtifactReference[]> {
  if (found.length > ARTIFACT_LIMITS.maxReferences) {
    throw invalidArtifact(
      `A version may refer to at most ${ARTIFACT_LIMITS.maxReferences} artifacts; this one has ${found.length} addresses.`
    )
  }
  const artifacts = new Map<string, Promise<ArtifactRecord | null>>()
  const versions = new Map<string, Promise<ArtifactVersionRecord | null>>()
  const resolved: ArtifactReference[] = []
  for (const reference of found) {
    const where = reference.at
      ? `In '${reference.at}', '${reference.address}'`
      : `'${reference.address}'`
    const address = parseArtifactAddress(reference.address)
    if (!address) {
      throw invalidArtifact(
        `${where} is not an artifact address: write artifact:<id>[@<version>][/<file>][#<part>], such as artifact:art_k3m9q2x7tp#chart=revenue.`
      )
    }
    if (address.artifactId === context.artifactId) {
      throw invalidArtifact(
        `${where} names the artifact being published. Link to one of its sections with #<slug> instead.`
      )
    }
    let artifact = artifacts.get(address.artifactId)
    if (!artifact) {
      artifact = context.storage
        .get({ projectId: context.projectId, id: address.artifactId })
        .then(async (record) => (record && (await context.readable(record)) ? record : null))
      artifacts.set(address.artifactId, artifact)
    }
    const record = await artifact
    if (!record) {
      throw invalidArtifact(`${where} names no artifact you can read.`)
    }
    const number = address.version ?? record.latestVersion
    const key = `${record.id}@${number}`
    let version = versions.get(key)
    if (!version) {
      version = context.storage.getVersion({
        projectId: context.projectId,
        artifactId: record.id,
        version: number,
      })
      versions.set(key, version)
    }
    const target = await version
    if (!target) throw invalidArtifact(`${where}: “${record.title}” has no version ${number}.`)
    const result = resolveArtifactAddress(address, { kind: record.kind, ...target })
    if ("problem" in result) {
      throw invalidArtifact(`${where}: “${target.title}” ${result.problem}.`)
    }
    resolved.push({ ...reference, resolvedVersion: target.version })
  }
  return resolved
}

/**
 * The artifacts a new version breaks: each one whose latest version follows this artifact's latest
 * and names something this version no longer has. Only artifacts the author can read are named,
 * and only those the version breaks are checked: most dependents cost no read.
 */
export async function brokenDependents(
  context: ReferenceContext,
  artifact: ArtifactRecord,
  version: ArtifactVersionRecord
): Promise<ArtifactWarning[]> {
  const dependents = await context.storage.listReferencingVersions({
    projectId: context.projectId,
    artifactId: artifact.id,
  })
  const warnings: ArtifactWarning[] = []
  for (const dependent of dependents) {
    if (dependent.artifactId === artifact.id) continue

    const broken: ArtifactWarning[] = []
    for (const reference of dependent.references) {
      const address = parseArtifactAddress(reference.address)
      // A pinned address keeps showing the version it names.
      if (address?.artifactId !== artifact.id || address.version !== undefined) continue
      const result = resolveArtifactAddress(address, { kind: artifact.kind, ...version })
      if (!("problem" in result)) continue
      broken.push({
        code: "reference_broken",
        message: `“${dependent.title}” (${dependent.artifactId}) ${reference.as === "embed" ? "shows" : "links to"} ${reference.address}, but version ${version.version} ${result.problem}. Publish its next version with an address that resolves, or restore what it names.`,
      })
    }
    if (broken.length === 0) continue

    const owner = await context.storage.get({
      projectId: context.projectId,
      id: dependent.artifactId,
    })
    if (owner && (await context.readable(owner))) warnings.push(...broken)
  }
  return warnings
}

/** What its author reads when nothing else is said: their own artifacts, or all for system code. */
export function ownArtifacts(author: Principal): (artifact: ArtifactRecord) => Promise<boolean> {
  return async (artifact) => author.type === "system" || principalsEqual(author, artifact.owner)
}
