import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { compareStrings } from "../json"
import { sha256Canonical } from "../materialization/identity"
import { getProjectionRegistry } from "../projections/capability"
import type { SixbDefinitions } from "../runtime/definitions"
import { type DefinitionKind, definitionKey, getDefinitionFiles } from "./files"
import type { DefinitionsManifest, ManifestDefinition, ManifestProjection } from "./types"

/** The parts of a host a manifest reads. */
export interface ManifestHost {
  readonly definitions: SixbDefinitions
  readonly projectRoot: string
}

export interface BuildDefinitionsManifestOptions {
  /** Defaults to `SIXB_COMMIT`, which `sixb deploy` sets. */
  readonly commit?: string | null
}

const manifests = new WeakMap<object, Promise<DefinitionsManifest>>()

/** A host's definitions never change, so its manifest is built once. */
export function readDefinitionsManifest(host: ManifestHost): Promise<DefinitionsManifest> {
  let manifest = manifests.get(host)
  if (!manifest) {
    manifest = buildDefinitionsManifest(host)
    manifests.set(host, manifest)
    manifest.catch(() => manifests.delete(host))
  }
  return manifest
}

export async function buildDefinitionsManifest(
  host: ManifestHost,
  options: BuildDefinitionsManifestOptions = {}
): Promise<DefinitionsManifest> {
  const files = getDefinitionFiles(host)
  const entries = listEntries(host.definitions)
  const ids = new Set(entries.map((entry) => entry.id))
  const fileHashes = new Map<string, Promise<string | null>>()
  const hashFile = (file: string) => {
    let hash = fileHashes.get(file)
    if (!hash) {
      hash = hashProjectFile(host.projectRoot, file)
      fileHashes.set(file, hash)
    }
    return hash
  }

  const definitions = await Promise.all(
    entries.map(async (entry): Promise<ManifestDefinition> => {
      const file = entry.file ?? files.get(definitionKey(entry.kind, entry.id)) ?? null
      const { value, hasCode } = fingerprint(entry.value, ids)
      // A handler's code lives in its file, and the file is the same wherever the commit runs.
      const code = hasCode && file !== null ? await hashFile(file) : null
      return { kind: entry.kind, id: entry.id, file, hash: sha256Canonical({ value, code }) }
    })
  )
  definitions.sort(
    (left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id)
  )

  return {
    commit: options.commit === undefined ? (process.env.SIXB_COMMIT ?? null) : options.commit,
    hash: sha256Canonical(definitions.map(({ kind, id, hash }) => [kind, id, hash])),
    definitions,
    projections: listProjections(host),
    datasets: host.definitions.datasets
      .list()
      .map((dataset) => structuredClone(dataset))
      .sort((left, right) => compareStrings(left.id, right.id)),
  }
}

interface Entry {
  readonly kind: DefinitionKind
  readonly id: string
  readonly value: unknown
  /** Set when the definition has a fixed place in the project, such as a skill's directory. */
  readonly file?: string
}

function listEntries(definitions: SixbDefinitions): Entry[] {
  const entries: Entry[] = []
  const add = (kind: DefinitionKind, values: readonly { readonly id: string }[]) => {
    for (const value of values) entries.push({ kind, id: value.id, value })
  }

  add("objectType", definitions.ontology.listObjectTypes())
  add("valueType", [...definitions.ontology.getValueTypesById().values()])
  add("action", definitions.actions.list())
  add("connector", definitions.connectors.list())
  add("dataset", definitions.datasets.list())
  add("pipeline", definitions.pipelines.list())
  add("projection", definitions.projections.list())
  add("rule", definitions.rules.list())
  add("schedule", definitions.schedules.list())
  add("share", definitions.shares.list())
  add("sync", definitions.syncs.list())
  add("workflow", definitions.workflows.list())
  add("marking", definitions.security.listMarkings())
  add("group", definitions.security.listGroups())
  add("role", definitions.security.listRoles())
  add("membershipPolicy", definitions.security.listMembershipPolicies())

  for (const tool of definitions.tools.list()) {
    entries.push({ kind: "tool", id: tool.name, value: tool })
  }
  for (const skill of definitions.agent.skills.list()) {
    entries.push({
      kind: "skill",
      id: skill.name,
      value: skill,
      file: `skills/${skill.name}/SKILL.md`,
    })
  }
  if (definitions.agent.instructions !== undefined) {
    entries.push({
      kind: "instructions",
      id: "SIXB.md",
      value: definitions.agent.instructions,
      file: "SIXB.md",
    })
  }

  return entries
}

function listProjections(host: ManifestHost): ManifestProjection[] {
  const registry = getProjectionRegistry(host)
  return host.definitions.projections
    .list()
    .map((projection) => {
      const resolved =
        projection._tag === "TelemetryProjectionDefinition"
          ? registry.resolveTelemetry(projection.id)
          : registry.resolveSource(projection.id)
      return {
        id: projection.id,
        // The three inputs of a projection run's identity besides the dataset version.
        revision: sha256Canonical([
          resolved.ontologyRevision,
          resolved.projectionRevision,
          resolved.ownershipHash,
        ]),
      }
    })
    .sort((left, right) => compareStrings(left.id, right.id))
}

async function hashProjectFile(projectRoot: string, file: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(resolve(projectRoot, file)))
      .digest("hex")
  } catch {
    // A runtime without its sources, such as one started from a copied build, compares by value.
    return null
  }
}

/**
 * A definition as plain JSON: functions are noted rather than serialized, since their compiled text
 * differs between a built and a source runtime, and a nested definition is named rather than
 * inlined, so a change to `Invoice` doesn't also change every type that links to it.
 */
function fingerprint(
  definition: unknown,
  ids: ReadonlySet<string>
): { readonly value: unknown; readonly hasCode: boolean } {
  let hasCode = false
  const ancestors = new Set<object>()

  const walk = (value: unknown, depth: number): unknown => {
    switch (typeof value) {
      case "string":
      case "boolean":
        return value
      case "number":
        return Number.isFinite(value) ? value : String(value)
      case "bigint":
        return `${value}n`
      case "function":
        hasCode = true
        return "[code]"
      case "undefined":
      case "symbol":
        return null
    }
    if (value === null) return null

    const object = value as object
    if (ancestors.has(object)) return "[cycle]"
    if (object instanceof Date) return object.toISOString()
    if (object instanceof RegExp) return object.toString()
    if (object instanceof Uint8Array) return createHash("sha256").update(object).digest("hex")
    if (depth > 0 && isDefinitionReference(object, ids)) return { $ref: object.id }

    ancestors.add(object)
    try {
      if (Array.isArray(object)) return object.map((item) => walk(item, depth + 1))
      if (object instanceof Map) {
        return [...object.entries()].map(([key, item]) => [
          walk(key, depth + 1),
          walk(item, depth + 1),
        ])
      }
      if (object instanceof Set) return [...object].map((item) => walk(item, depth + 1))

      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(object)) {
        if (item === undefined || typeof item === "symbol") continue
        result[key] = walk(item, depth + 1)
      }
      return result
    } finally {
      ancestors.delete(object)
    }
  }

  return { value: walk(definition, 0), hasCode }
}

function isDefinitionReference(
  value: object,
  ids: ReadonlySet<string>
): value is { readonly id: string } {
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === "string" &&
    ids.has(candidate.id) &&
    ("_tag" in candidate || "kind" in candidate || Array.isArray(candidate.properties))
  )
}
