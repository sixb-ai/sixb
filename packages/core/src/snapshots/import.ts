import { randomUUID } from "node:crypto"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import { createKernelScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import { sha256Canonical } from "../materialization/identity"
import type { OntologyRegistry } from "../ontology"
import { collectArtifactRefIds } from "../ontology/artifact-ref"
import { UNIQUE_VALUE_KEY_VERSION, uniqueValueKey } from "../ontology/unique-values"
import type { UserRef } from "../ontology/user-ref"
import type { OntologyCommitRecord } from "../storage/ontology/commits"
import type {
  ExactArtifactHolderWrite,
  ExactUniqueValueClaim,
} from "../storage/ontology/materializations"
import type { PreparedUniqueProperty } from "../storage/ontology/unique-values"
import {
  isSnapshotLoadStorage,
  type SnapshotLinkWrite,
  type SnapshotLoader,
  type SnapshotLoadStorage,
  type SnapshotObjectWrite,
} from "../storage/snapshots"
import type { Storage } from "../storage/types"
import {
  type BranchDefinitions,
  type BranchTypeDefinition,
  branchDefinitions,
  checkTypeFits,
} from "./definitions"
import {
  decodeSnapshot,
  fromColumns,
  type SnapshotEnd,
  type SnapshotLinks,
  type SnapshotManifest,
  type SnapshotMembers,
  type SnapshotObjects,
  type SnapshotPoints,
  type SnapshotRecord,
  type SnapshotTypeManifest,
  type SnapshotVectors,
} from "./format"

export interface ImportSnapshotInput {
  /** The snapshot's bytes, from a file or straight from {@link exportSnapshot}. */
  readonly snapshot: AsyncIterable<Uint8Array>
  /** The branch's storage: a namespace that holds no object yet. */
  readonly storage: Storage
  /** The branch's definitions: each type is checked against them, and imported if it fits. */
  readonly ontology: OntologyRegistry
}

export interface SnapshotImportReport {
  readonly projectId: string
  readonly takenAt: string
  readonly takenBy: UserRef
  /** The base commit every imported row belongs to. */
  readonly commitId: string
  readonly members: "all" | "self"
  readonly users: number
  readonly types: readonly ImportedSnapshotType[]
  /** Types left out, and why: unreadable in production, or no longer fitting the branch. */
  readonly skipped: readonly { readonly objectTypeId: string; readonly reason: string }[]
}

export interface ImportedSnapshotType {
  readonly objectTypeId: string
  readonly objects: number
  readonly links: number
  readonly points: number
  readonly vectors: number
  /** Properties the person cannot read: no object holds a value for them. */
  readonly hiddenPropertyIds: readonly string[]
  /** Properties the branch no longer defines, left out. */
  readonly droppedPropertyIds: readonly string[]
  /** Links left out because the branch removed or redefined them, or skipped their target. */
  readonly droppedLinks: number
  /** Vector profiles left out, and why. */
  readonly skippedVectors: readonly { readonly profile: string; readonly reason: string }[]
  /** Set for a type a projection feeds in production, which cannot run on the branch yet. */
  readonly projectionId?: string
}

/**
 * Load a snapshot into a branch's storage as one base commit: no event is emitted and no outbox
 * row is written, so nothing reacts to the import. Unique values and artifact references are
 * derived from the objects, as a write would, and the provider indexes after the load.
 */
export async function importSnapshot(input: ImportSnapshotInput): Promise<SnapshotImportReport> {
  const storage = input.storage
  if (!isSnapshotLoadStorage(storage)) {
    throw new Error(
      "[Sixb] This storage provider cannot load a snapshot. Use PostgreSQL, SQLite or in-memory storage."
    )
  }

  const records = decodeSnapshot(input.snapshot)[Symbol.asyncIterator]()

  // A failed import closes the stream it reads, so an export feeding it ends its read too.
  try {
    const manifest = await expectRecord(records, "manifest")
    const members = await expectRecord(records, "members")

    const definitions = branchDefinitions(input.ontology)
    const plan = new ImportPlan(manifest, definitions)
    const users = await importMembers(storage, manifest.projectId, members)
    const commit = await baseCommit(storage, manifest, definitions)

    const end = await storage.loadSnapshot(
      {
        projectId: manifest.projectId,
        commit,
        uniqueProperties: plan.uniqueProperties(),
        objectTypeIds: plan.objectTypeIds(),
      },
      (loader) =>
        loadRecords(records, plan, loader, { commitId: commit.id, ontology: input.ontology })
    )
    assertComplete(end, plan, members.users.length)

    // Read the stream to its close, which checks nothing follows its end and lets its source end.
    if (!(await records.next()).done) {
      throw new Error("[Sixb] The snapshot cannot be read: frames follow its end.")
    }

    return report(manifest, plan, commit.id, users)
  } catch (error) {
    await records.return?.(undefined).catch(() => undefined)
    throw error
  }
}

/**
 * The counts the snapshot's end records must match what it held: a stream that lost or repeated
 * a frame on its way is refused, and the load with it.
 */
function assertComplete(end: SnapshotEnd, plan: ImportPlan, users: number): void {
  const expected: SnapshotEnd["counts"] = end.counts
  const actual: SnapshotEnd["counts"] = { ...plan.read, users }

  for (const key of Object.keys(expected) as (keyof SnapshotEnd["counts"])[]) {
    if (expected[key] === actual[key]) continue
    throw new Error(
      `[Sixb] The snapshot cannot be read: it says it holds ${expected[key]} ${key}, and holds ${actual[key]}. Take it again.`
    )
  }
}

export function report(
  manifest: SnapshotManifest,
  plan: ImportPlan,
  commitId: string,
  users: number
): SnapshotImportReport {
  return {
    projectId: manifest.projectId,
    takenAt: manifest.takenAt,
    takenBy: manifest.takenBy,
    commitId,
    members: manifest.members,
    users,
    types: plan.report(),
    skipped: plan.skipped,
  }
}

async function expectRecord<K extends SnapshotRecord["kind"]>(
  records: AsyncIterator<SnapshotRecord>,
  kind: K
): Promise<Extract<SnapshotRecord, { kind: K }>> {
  const next = await records.next()
  if (next.done || next.value.kind !== kind) {
    throw new Error(`[Sixb] The snapshot cannot be read: its ${kind} is missing.`)
  }
  return next.value as Extract<SnapshotRecord, { kind: K }>
}

/**
 * The load's execution, the kernel operation `ontology.loadSnapshot`, and its commit, which lists
 * no change: its rows are what it holds.
 */
export async function baseCommit(
  storage: Pick<Storage, "executions">,
  manifest: SnapshotManifest,
  definitions: BranchDefinitions
): Promise<OntologyCommitRecord> {
  const id = `snapshot_${randomUUID()}`
  const scope = createKernelScope({
    projectId: manifest.projectId,
    operation: { type: "ontology.loadSnapshot", snapshotId: id },
    source: { type: "http", requestId: id },
    correlationId: id,
  })
  await ensureExecutionRecord(storage.executions, {
    ...executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
    requesterGroupIds: [],
  })

  const committedAt = new Date().toISOString()
  return {
    projectId: manifest.projectId,
    id,
    idempotencyKey: id,
    requestHash: sha256Canonical({ snapshot: manifest.takenAt, takenBy: manifest.takenBy }),
    executionId: scope.execution.id,
    origin: { kind: "runtime", requestId: id },
    ontologyRevision: definitions.ontologyRevision,
    committedAt,
    intent: { kind: "edit", mode: "atomic", operationCount: 0 },
    result: {
      kind: "edit",
      commitId: id,
      created: true,
      eventCount: 0,
      committedAt,
      outcomes: [],
      changes: { objects: [], links: [] },
    },
  }
}

export interface TypePlan {
  readonly manifest: SnapshotTypeManifest
  /** The branch's definition of the type. */
  readonly definition: BranchTypeDefinition
  readonly droppedPropertyIds: ReadonlySet<string>
  readonly droppedLinkIds: ReadonlySet<string>
  readonly telemetryPropertyIds: ReadonlySet<string>
  readonly unique: BranchTypeDefinition["unique"]
  readonly counts: {
    objects: number
    links: number
    points: number
    vectors: number
    droppedLinks: number
  }
  readonly skippedVectors: Map<string, string>
}

/**
 * What each type of the snapshot becomes on the branch, decided from the branch's definitions as
 * data: a copy production takes plans it without the branch's code.
 */
export class ImportPlan {
  readonly #types = new Map<string, TypePlan>()
  readonly skipped: { objectTypeId: string; reason: string }[] = []
  /** What the snapshot held, skipped types included, to check against its end. */
  readonly read = { objects: 0, links: 0, points: 0, vectors: 0 }

  constructor(manifest: SnapshotManifest, definitions: BranchDefinitions) {
    for (const objectTypeId of manifest.unreadableTypeIds) {
      this.skipped.push({ objectTypeId, reason: "the person who took it cannot read this type" })
    }

    for (const type of manifest.types) {
      const definition = definitions.types[type.objectTypeId]
      const fit = checkTypeFits(type, definition)
      if (!definition || !fit.fits) {
        this.skipped.push({
          objectTypeId: type.objectTypeId,
          reason: fit.fits ? "the branch no longer defines this type" : fit.reason,
        })
        continue
      }

      this.#types.set(type.objectTypeId, {
        manifest: type,
        definition,
        droppedPropertyIds: new Set(fit.droppedPropertyIds),
        droppedLinkIds: new Set(fit.droppedLinkIds),
        telemetryPropertyIds: new Set(definition.telemetryPropertyIds),
        // A property production did not hold unique may hold one value twice: the branch's own
        // preparation backfills it, and refuses the duplicates as it would anywhere else.
        unique: definition.unique.filter((property) =>
          type.uniquePropertyIds.includes(property.propertyId)
        ),
        counts: { objects: 0, links: 0, points: 0, vectors: 0, droppedLinks: 0 },
        skippedVectors: new Map(),
      })
    }
  }

  type(objectTypeId: string): TypePlan | undefined {
    return this.#types.get(objectTypeId)
  }

  objectTypeIds(): readonly string[] {
    return [...this.#types.keys()]
  }

  uniqueProperties(): readonly PreparedUniqueProperty[] {
    return [...this.#types.values()].flatMap((plan) =>
      plan.unique.map((property) => ({
        objectTypeId: plan.manifest.objectTypeId,
        propertyId: property.propertyId,
        keyKind: property.kind,
        keyVersion: UNIQUE_VALUE_KEY_VERSION,
      }))
    )
  }

  /** Whether the branch keeps a link: its definition still fits, and its target was imported. */
  keepsLink(plan: TypePlan, linkId: string, targetTypeId: string): boolean {
    if (plan.droppedLinkIds.has(linkId) || !this.#types.has(targetTypeId)) return false

    return plan.definition.linkTargets[linkId]?.typeIds.includes(targetTypeId) === true
  }

  /** How the branch keys a link's row: one per source for a single link, one per edge otherwise. */
  linkIdentity(plan: TypePlan, linkId: string): "slot" | "edge" {
    return plan.definition.linkTargets[linkId]?.cardinality === "one" ? "slot" : "edge"
  }

  /** Why the branch leaves out a profile's vectors, or `undefined` when it keeps them. */
  skipsVectors(plan: TypePlan, profile: string, configuration: string): string | undefined {
    const branch = plan.definition.vectors[profile]
    if (branch === undefined) return "the branch no longer defines this profile"
    if (branch !== configuration) {
      return "the branch embeds it differently: its vectors are computed again"
    }
    return undefined
  }

  report(): readonly ImportedSnapshotType[] {
    return [...this.#types.values()].map((plan) => ({
      objectTypeId: plan.manifest.objectTypeId,
      objects: plan.counts.objects,
      links: plan.counts.links,
      points: plan.counts.points,
      vectors: plan.counts.vectors,
      hiddenPropertyIds: plan.manifest.hiddenPropertyIds,
      droppedPropertyIds: [...plan.droppedPropertyIds],
      droppedLinks: plan.counts.droppedLinks,
      skippedVectors: [...plan.skippedVectors].map(([profile, reason]) => ({ profile, reason })),
      ...(plan.manifest.projection ? { projectionId: plan.manifest.projection.projectionId } : {}),
    }))
  }
}

/** Load every record after the members, and return the snapshot's end. */
async function loadRecords(
  records: AsyncIterator<SnapshotRecord>,
  plan: ImportPlan,
  loader: SnapshotLoader,
  load: LoadContext
): Promise<SnapshotEnd> {
  // The next frame is read and decompressed while the provider writes this one.
  const ahead = () => {
    const next = records.next()
    next.catch(() => undefined)
    return next
  }

  for (let pending = ahead(), next = await pending; !next.done; next = await pending) {
    pending = ahead()
    const record = next.value

    switch (record.kind) {
      case "objects":
        plan.read.objects += record.ids.length
        await loadObjects(plan, loader, record, load.ontology)
        break
      case "links":
        plan.read.links += record.rows.length
        await loadLinks(plan, loader, record)
        break
      case "points":
        plan.read.points += record.rows.length
        await loadPoints(plan, loader, record)
        break
      case "vectors":
        plan.read.vectors += record.ids.length
        await loadVectors(plan, loader, record, load.commitId)
        break
      case "end":
        return record
      default:
        throw new Error(
          `[Sixb] The snapshot cannot be read: a '${record.kind}' frame is misplaced.`
        )
    }
  }

  throw new Error("[Sixb] The snapshot cannot be read: its end is missing.")
}

/** What the load reads beyond the plan: the commit, and the schemas artifact references are in. */
interface LoadContext {
  readonly commitId: string
  readonly ontology: OntologyRegistry
}

async function loadObjects(
  plan: ImportPlan,
  loader: SnapshotLoader,
  record: SnapshotObjects,
  ontology: OntologyRegistry
) {
  const type = plan.type(record.objectTypeId)
  if (!type) return

  const objectTypeId = record.objectTypeId
  const valueTypes = ontology.getValueTypesById()
  const artifactRefs = ontology.listArtifactRefProperties(objectTypeId)
  const objects: SnapshotObjectWrite[] = []
  const uniqueValues: ExactUniqueValueClaim[] = []
  const artifactHolders: ExactArtifactHolderWrite[] = []

  fromColumns(record).forEach((properties, index) => {
    const primaryId = record.ids[index]!
    for (const propertyId of type.droppedPropertyIds) delete properties[propertyId]

    const edited: Record<string, JsonValue> = {}
    for (const propertyId in properties) {
      if (!type.telemetryPropertyIds.has(propertyId)) edited[propertyId] = properties[propertyId]!
    }

    objects.push({
      objectTypeId,
      primaryId,
      properties,
      override: { kind: "create", properties: edited },
      createdAt: new Date(record.createdAt[index]!).toISOString(),
      updatedAt: new Date(record.updatedAt[index]!).toISOString(),
    })

    for (const { propertyId, kind } of type.unique) {
      const valueKey = uniqueValueKey(kind, properties[propertyId])
      if (valueKey === null) continue
      uniqueValues.push({
        objectTypeId,
        propertyId,
        valueKey,
        primaryId,
        keyKind: kind,
        keyVersion: UNIQUE_VALUE_KEY_VERSION,
      })
    }

    for (const property of artifactRefs) {
      const value = properties[property.id]
      if (value === undefined) continue
      for (const artifactId of collectArtifactRefIds(
        property.schema,
        value,
        valueTypes,
        new Set()
      )) {
        artifactHolders.push({ objectTypeId, primaryId, propertyId: property.id, artifactId })
      }
    }
  })

  type.counts.objects += objects.length
  await loader.write({ objects, uniqueValues, artifactHolders })
}

async function loadLinks(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotLinks) {
  const type = plan.type(record.sourceTypeId)
  if (!type) return

  const links: SnapshotLinkWrite[] = []
  for (const [
    sourceId,
    linkId,
    targetTypeId,
    targetId,
    createdAt,
    updatedAt,
    properties,
  ] of record.rows) {
    if (!plan.keepsLink(type, linkId, targetTypeId)) {
      type.counts.droppedLinks += 1
      continue
    }

    links.push({
      sourceTypeId: record.sourceTypeId,
      sourceId,
      linkId,
      targetTypeId,
      targetId,
      ...(properties === null ? {} : { properties }),
      identity: plan.linkIdentity(type, linkId),
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    })
  }

  type.counts.links += links.length
  if (links.length > 0) await loader.write({ links })
}

async function loadPoints(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotPoints) {
  const type = plan.type(record.objectTypeId)
  if (!type) return

  const points = record.rows
    .filter(([, propertyId]) => type.telemetryPropertyIds.has(propertyId))
    .map(([objectId, propertyId, value, unit, at]) => ({
      objectTypeId: record.objectTypeId,
      objectId,
      propertyId,
      value,
      ...(unit === null ? {} : { unit }),
      at: new Date(at).toISOString(),
    }))

  type.counts.points += points.length
  if (points.length > 0) await loader.write({ points })
}

/** Vectors are kept only when the branch embeds the profile exactly as production did. */
async function loadVectors(
  plan: ImportPlan,
  loader: SnapshotLoader,
  record: SnapshotVectors,
  commitId: string
) {
  const type = plan.type(record.objectTypeId)
  if (!type) return

  const skipped = plan.skipsVectors(type, record.profile, record.configuration)
  if (skipped) {
    type.skippedVectors.set(record.profile, skipped)
    return
  }

  const bytes = Buffer.from(record.values, "base64")
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
  const vectors = record.ids.map((primaryId, index) => ({
    ref: { objectTypeId: record.objectTypeId, primaryId },
    profile: record.profile,
    configuration: record.configuration,
    source: record.source,
    sourceFingerprint: record.sourceFingerprints[index]!,
    values: Array.from(values.subarray(index * record.dimensions, (index + 1) * record.dimensions)),
    lastCommitId: commitId,
  }))

  type.counts.vectors += vectors.length
  await loader.write({ vectors })
}

/**
 * Members go in before the objects, in a transaction of their own: they are not part of the
 * ontology's commit. They are written so that a load taken again after a failure finds them.
 */
async function importMembers(
  storage: SnapshotLoadStorage,
  projectId: string,
  members: SnapshotMembers
): Promise<number> {
  const auth = storage.auth
  if (!auth || members.users.length === 0) return 0

  await storage.transaction(async (tx) => {
    const store = tx.auth ?? auth

    for (const [id, email, displayName, avatarUrl, status, createdAt, updatedAt] of members.users) {
      // A load that failed before leaves its members: taking the snapshot again keeps them.
      if (await store.users.getById({ projectId, id })) continue

      await store.users.create({
        id,
        projectId,
        email,
        ...(displayName === null ? {} : { displayName }),
        ...(avatarUrl === null ? {} : { avatarUrl }),
        status,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
      })
    }

    for (const [userId, groupId, source, createdAt] of members.memberships) {
      await store.groupMemberships.upsert({
        projectId,
        userId,
        groupId,
        source,
        createdAt: new Date(createdAt),
      })
    }
  })

  return members.users.length
}
