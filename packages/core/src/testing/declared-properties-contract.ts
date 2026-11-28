import { expect, test } from "bun:test"
import {
  type AuthorizationContext,
  can,
  col,
  type DatasetDefinition,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineProjection,
  defineRole,
  link,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from ".."
import { InMemoryBlobStorage } from "../blob-storage"
import { InMemoryBroker } from "../broker"
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import { InMemoryLakeStorage } from "../lake-storage"
import { createOntologyMaterializer, ProjectionRegistry } from "../materializer"
import { InMemoryQueues } from "../queues"
import { exportSnapshot, hostSnapshotSource } from "../snapshots/export"
import { decodeSnapshot, type SnapshotRecord } from "../snapshots/format"
import { migrateStorage } from "../storage/migrations"
import type { SnapshotReadStorage } from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { createTestSixb } from "./execution"
import { startTestProjectionRun } from "./projection-execution"

export interface DeclaredPropertiesContractProvider<TStorage extends Storage> {
  /** A migrated storage holding no project yet. */
  readonly createStorage: () => Promise<TStorage & SnapshotReadStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

// Doors kept their access code in `gate`, and vaults, a kind of door, their combination in
// `combo`, both marked. The code then renamed `gate` to `gateCode`, still marked, and dropped
// `combo`. The stored objects still hold `gate` and `combo`: an edit-created door, a projected
// one whose edit of `gate` lost to a newer source row, and a vault. No reader receives either,
// with or without the marking. Link properties are out of scope: they cannot be marked, and
// following their renames is later work.

const PROJECT = "declared-properties-contract"
const TIMEOUT_MS = 30_000

const secret = defineMarking("declared-properties-secret")
const guards = defineGroup("declared-properties-guards")
const keepers = defineGroup("declared-properties-keepers")

const DoorBefore = defineObjectType({
  id: "DeclaredDoor",
  name: "Door",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("gate", "string", { markings: [secret] }),
  ],
})
const VaultBefore = defineObjectType({
  id: "DeclaredVault",
  name: "Vault",
  extends: DoorBefore,
  properties: [prop("combo", "string", { markings: [secret] })],
  links: [link("door", DoorBefore, { cardinality: "one" })],
})

const Door = defineObjectType({
  id: "DeclaredDoor",
  name: "Door",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("gateCode", "string", { markings: [secret] }),
  ],
})
const Vault = defineObjectType({
  id: "DeclaredVault",
  name: "Vault",
  extends: Door,
  properties: [prop("floor", "double")],
  links: [link("door", Door, { cardinality: "one" })],
})

const doors = defineDataset("declared_properties_doors", {
  schema: [
    col("id", "string"),
    col("name", "string"),
    col("gate", "string", { markings: [secret] }),
    col("updated_at", "timestamp"),
  ],
})
// The newest value wins, so a source row can beat an edit made before it.
const doorsProjection = defineProjection("declared_properties_doors", DoorBefore)
  .fromDataset(doors)
  .properties({ id: "id", name: "name", gate: "gate" })
  .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })

const before = new OntologyRegistry({ sources: [DoorBefore, VaultBefore] })
const after = new OntologyRegistry({ sources: [Door, Vault] })

/**
 * Reading objects that hold keys their type no longer declares, on a storage provider: every read
 * returns only declared properties, so a value left under a renamed property's old id never
 * reaches a reader, marked or not, and never breaks the read.
 *
 * Reproduce the leak: in `objects/clearance-redaction.ts`, make `readableOnly` return `record`
 * whatever it holds, and every case but lineage receives `gate` or `combo`. In `lineage/object.ts`,
 * explain every property `explainEffectiveObject` decided, and lineage explains `gate` again.
 */
export function runDeclaredPropertiesContractSuite<TStorage extends Storage>(
  name: string,
  provider: DeclaredPropertiesContractProvider<TStorage>
): void {
  async function withStored(run: (readers: Readers) => Promise<void>): Promise<void> {
    const storage = await provider.createStorage()
    const shared = {
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      queues: new InMemoryQueues(),
      blobStorage: new InMemoryBlobStorage(),
      storage,
    }
    const hosts: SixbHost[] = []

    try {
      const writer = new SixbHost({ ...hostOptions([DoorBefore, VaultBefore]), ...shared })
      hosts.push(writer)
      await seed(storage, writer)
      // Its outbox drains on stop: every event it wrote is then in the shared broker.
      await writer.closeBroker()

      await migrateStorage(storage, { projectId: PROJECT, ontology: after })
      const host = new SixbHost({ ...hostOptions([Door, Vault]), ...shared })
      hosts.push(host)

      await run({
        host,
        trusted: createTestSixb(host),
        guard: createTestSixb(host, { authorization: contextFor(host, guards.id) }),
        keeper: createTestSixb(host, { authorization: contextFor(host, keepers.id) }),
      })
    } finally {
      for (const host of hosts) await host.closeBroker()
      await provider.cleanup?.(storage)
    }
  }

  test(
    `${name} reads objects without the keys their type no longer declares`,
    async () => {
      await withStored(async ({ trusted, guard, keeper }) => {
        for (const reader of [trusted, keeper]) {
          expect((await reader.objects.get(Door.id, "d-edited"))?.properties).toEqual({
            id: "d-edited",
            name: "Front",
          })
          expect(await reader.objects(Door).byId("d-projected").get()).toMatchObject({
            properties: { id: "d-projected", name: "Side" },
          })
          expect((await reader.objects.get(Vault.id, "v-1"))?.properties).toEqual({
            id: "v-1",
            name: "Basement",
          })
        }

        // The marked property is redacted under its new id, and its value is under neither.
        const door = await guard.objects.get(Door.id, "d-edited")
        expect(door?.properties).toEqual({ id: "d-edited", name: "Front" })
        expect(door?.redactions).toEqual({ gateCode: { reason: "missing_clearance" } })

        for (const reader of [trusted, keeper, guard]) {
          const listed = await reader.objects.list({ objectTypeIds: [Door.id, Vault.id] })
          expect(listed.objects.map((row) => row.primaryId).sort()).toEqual([
            "d-edited",
            "d-projected",
            "v-1",
          ])
          expectNoStaleValue(listed)
        }
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} queries, expands and follows links without them`,
    async () => {
      await withStored(async ({ trusted, guard }) => {
        for (const reader of [trusted, guard]) {
          const expanded = await reader.objects.executeQuery({
            query: {
              kind: "expand",
              input: {
                kind: "limit",
                limit: 10,
                input: { kind: "start", objectTypeId: Door.id, includeSubtypes: true },
              },
              expansions: [{ linkId: "door", direction: "outgoing" }],
            },
          })
          expect(expanded.objects).toHaveLength(3)
          expect(
            expanded.objects.find((row) => row.primaryId === "v-1")?.links?.door
          ).toMatchObject({ primaryId: "d-edited", properties: { id: "d-edited", name: "Front" } })
          expectNoStaleValue(expanded)

          const followed = await reader.objects.queryLinks({
            query: { kind: "start", objectTypeId: Vault.id },
            linkId: "door",
            includeObjects: true,
          })
          // Both ends of each link, the vault included.
          expect(followed.objects.map((row) => row.primaryId).sort()).toEqual(["d-edited", "v-1"])
          expectNoStaleValue(followed)
        }
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} delivers object events without them`,
    async () => {
      await withStored(async ({ trusted, guard }) => {
        for (const reader of [trusted, guard]) {
          const events = await reader.events.read()
          const objectEvents = events.filter((event) => event.topic === "objects")

          // Three creations; the edited door's code updated; the projected door's code edited,
          // then won back by its source.
          expect(objectEvents.map((event) => event.type).sort()).toEqual([
            "object.created",
            "object.created",
            "object.created",
            "object.updated",
            "object.updated",
            "object.updated",
          ])
          expectNoStaleValue(objectEvents)
        }
      })
    },
    TIMEOUT_MS
  )

  test(
    `${name} explains where values come from without them`,
    async () => {
      await withStored(async ({ trusted, guard }) => {
        for (const reader of [trusted, guard]) {
          const edited = await reader.objects(Door).lineage("d-edited")
          expect(Object.keys(edited?.properties ?? {})).toEqual(["id", "name"])

          // The edit of `gate` the source won over is not shown, as `replaced` or otherwise.
          const projected = await reader.objects(Door).lineage("d-projected")
          expect(Object.keys(projected?.properties ?? {})).toEqual(["id", "name"])
          expectNoStaleValue(projected)

          const vault = await reader.objects(Vault).lineage("v-1")
          expect(Object.keys(vault?.properties ?? {})).toEqual(["id", "name"])
        }
      })
    },
    TIMEOUT_MS
  )

  // A type that travels as its source sends its edits too: `branch-projection.test.ts` in
  // `@sixb/projection-worker` proves those keep only declared properties.
  test(
    `${name} keeps them out of a snapshot's objects`,
    async () => {
      await withStored(async ({ host }) => {
        for (const group of [guards.id, keepers.id]) {
          const records = await readSnapshot(
            exportSnapshot(hostSnapshotSource(host), {
              scope: createTestingScope({ projectId: PROJECT, context: contextFor(host, group) }),
              concurrency: 1,
              pageSize: 2,
            })
          )

          const objects = records.flatMap((record) => (record.kind === "objects" ? [record] : []))
          expect(objects.flatMap((record) => record.ids).sort()).toEqual([
            "d-edited",
            "d-projected",
            "v-1",
          ])
          // The manifest names the stale keys a deploy would refuse, with no count and no
          // value (`withheld`): only that may name them.
          const named = records.flatMap((record) =>
            record.kind === "manifest" ? record.types.map((type) => type.shape?.withheld) : []
          )
          expect(named).toEqual([["gate"], ["combo", "gate"]])
          expectNoStaleValue(records.map(withoutWithheldKeys))
        }
      })
    },
    TIMEOUT_MS
  )
}

interface Readers {
  readonly host: SixbHost
  readonly trusted: ReturnType<typeof createTestSixb>
  /** Views doors and vaults, without the marking. */
  readonly guard: ReturnType<typeof createTestSixb>
  /** Views doors and vaults, cleared for the marking. */
  readonly keeper: ReturnType<typeof createTestSixb>
}

/** A snapshot record without the stale keys its manifest names on purpose. */
function withoutWithheldKeys(record: SnapshotRecord): SnapshotRecord {
  if (record.kind !== "manifest") return record

  return {
    ...record,
    types: record.types.map(({ shape, ...type }) => {
      if (!shape) return type
      const { withheld: _withheld, ...kept } = shape
      return { ...type, shape: kept }
    }),
  }
}

/** No value stored under `gate` or `combo` appears anywhere in what a reader received. */
function expectNoStaleValue(received: unknown): void {
  const text = JSON.stringify(received)

  expect(text).not.toContain("stale-")
  expect(text).not.toContain('"gate"')
  expect(text).not.toContain('"combo"')
}

function hostOptions(ontology: readonly ObjectTypeWithPropertyTokens[]) {
  const viewDoors = can.view(ontology)

  return {
    id: PROJECT,
    ontology,
    markings: [secret],
    groups: [guards, keepers],
    roles: [
      defineRole("declared-properties-guard", { grantedTo: [guards], grants: [viewDoors] }),
      defineRole("declared-properties-keeper", {
        grantedTo: [keepers],
        grants: [viewDoors],
        clearances: [secret],
      }),
    ],
  }
}

function contextFor(host: SixbHost, groupId: string): AuthorizationContext {
  return resolveAuthorizationContext({
    principal: { type: "user", id: `usr_${groupId}` },
    groupIds: [groupId],
    roles: host.definitions.security.listResolvedRoles(),
  })
}

/**
 * What the code before the rename wrote: an edit and its update, a vault, and a projected door
 * whose edit of `gate` loses to a newer source row.
 */
async function seed(storage: Storage, writer: SixbHost): Promise<void> {
  await migrateStorage(storage, { projectId: PROJECT, ontology: before })
  const trusted = createTestSixb(writer)

  await trusted
    .objects(DoorBefore)
    .upsert({ properties: { id: "d-edited", name: "Front", gate: "stale-gate-1" } })
  await trusted.objects(DoorBefore).upsert({ properties: { id: "d-edited", gate: "stale-gate-2" } })
  await trusted.objects(VaultBefore).upsert({
    properties: { id: "v-1", name: "Basement", gate: "stale-gate-3", combo: "stale-combo" },
  })
  await trusted.objects(VaultBefore).byId("v-1").link(VaultBefore.l.door, {
    objectTypeId: DoorBefore.id,
    primaryId: "d-edited",
  })

  const row = { id: "d-projected", name: "Side" }
  await project(storage, 1, { ...row, gate: "stale-gate-4" }, "2026-11-01T00:00:00.000Z")
  await trusted.objects(DoorBefore).upsert({ properties: { id: row.id, gate: "stale-gate-5" } })
  // Later than any edit this test makes, so the source wins `gate` back.
  await project(storage, 2, { ...row, gate: "stale-gate-6" }, "2099-01-01T00:00:00.000Z")
}

/** One replacement publication of the doors projection, as its run applies it. */
async function project(
  storage: Storage,
  version: number,
  properties: Readonly<Record<string, string>>,
  sourceUpdatedAt: string
) {
  const projections = new ProjectionRegistry({
    projections: [doorsProjection],
    ontology: before,
    datasetsById: new Map<string, DatasetDefinition>([[doors.id, doors]]),
  })
  const resolved = projections.resolveSource(doorsProjection.id)
  const datasetVersion = {
    datasetId: doors.id,
    versionId: `doors-v${version}`,
    createdAt: `2026-11-0${version}T00:00:00.000Z`,
  }

  const runId = `declared-properties-doors-run-${version}`
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: doorsProjection.id,
      datasetVersion,
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: DoorBefore.id },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`[Sixb] Test execution for '${runId}' is missing.`)

  const materializer = createOntologyMaterializer({
    projectId: PROJECT,
    ontology: before,
    projections,
    storage,
  }).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: doorsProjection.id, runId },
    })
  )

  const ref = { objectTypeId: DoorBefore.id, primaryId: properties.id ?? "" }
  await materializer.projections.replace({
    source: { projectionId: doorsProjection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield {
        root: { kind: "object", ref },
        assertions: [{ kind: "object", ref, properties, sourceUpdatedAt }],
      }
    })(),
  })
}

async function readSnapshot(snapshot: AsyncIterable<Uint8Array>): Promise<SnapshotRecord[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of snapshot) chunks.push(chunk)

  const records: SnapshotRecord[] = []
  for await (const record of decodeSnapshot(chunks)) records.push(record)
  return records
}
