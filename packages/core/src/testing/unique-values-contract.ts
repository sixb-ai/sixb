import { expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineValueType,
  OntologyRegistry,
  prop,
  ref,
  type Storage,
  valueTypeRef,
} from ".."
import { restoreTrustedPrimitiveExecutionScope } from "../execution/durable"
import { createTestingScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import { UniqueValueViolationError } from "../materialization/errors"
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  type OntologyMaterializer,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import { migrateStorage } from "../storage/migrations"
import { startTestProjectionRun } from "./projection-execution"

export interface UniqueValuesContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /**
   * Write transactions run side by side instead of one after another. Resolves once `competing`
   * waits on a lock another transaction holds, or once it settles without waiting.
   */
  readonly waitForLockWait?: (storage: TStorage, competing: Promise<unknown>) => Promise<void>
  /**
   * The store holds every object, so it builds a property's values when a claim first needs them
   * instead of refusing it until `migrateStorage` prepared them.
   */
  readonly preparesOnClaim?: boolean
}

const PROJECT = "unique-values-contract"

const Person = defineObjectType({
  id: "UniqueContractPerson",
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { nullable: true, unique: true }),
    prop("user", ref.user(), { nullable: true, unique: true }),
    prop("badge", "integer", { unique: true }),
    prop("name", "string"),
  ],
})

/** Inherits `email`, unique among employees only. */
const Employee = defineObjectType({
  id: "UniqueContractEmployee",
  name: "Employee",
  extends: Person.id,
  properties: [],
})

const people = defineDataset("unique_contract_people", {
  schema: [col("id", "string"), col("email", "string", { nullable: true }), col("name", "string")],
})

const peopleProjection = defineProjection("unique_contract_people", Person)
  .fromDataset(people)
  .properties({ id: "id", email: "email", name: "name" })

const ontology = new OntologyRegistry({ sources: [Person, Employee] })

const projections = new ProjectionRegistry({
  projections: [peopleProjection],
  ontology,
  datasetsById: new Map<string, DatasetDefinition>([[people.id, people]]),
})

/** The same people, before `email` became unique. */
const PlainPerson = defineObjectType({
  id: Person.id,
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { nullable: true }),
    prop("user", ref.user(), { nullable: true, unique: true }),
    prop("name", "string"),
  ],
})
const plainOntology = new OntologyRegistry({ sources: [PlainPerson] })

/**
 * Unique properties on a storage provider: every object write keeps their values, so a value is
 * held by at most one object of its exact type, whichever ingress wrote it.
 */
export function runUniqueValuesContractSuite<TStorage extends Storage>(
  name: string,
  provider: UniqueValuesContractProvider<TStorage>
): void {
  async function withStorage(
    run: (storage: TStorage) => Promise<void>,
    options: { readonly prepared?: boolean } = {}
  ): Promise<void> {
    const storage = await provider.createStorage()
    try {
      if (options.prepared ?? true) await migrateStorage(storage, { projectId: PROJECT, ontology })
      await run(storage)
    } finally {
      await provider.cleanup?.(storage)
    }
  }

  test(`${name} refuses a value another object holds and keeps the first object`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([create("a", { email: "ada@example.com" })])
      await edits.commit([create("b", { email: "bob@example.com" })])

      const refused = await edits
        .commit([create("c", { email: "ada@example.com" })])
        .catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(UniqueValueViolationError)
      expect(refused).toMatchObject({
        objectTypeId: Person.id,
        propertyId: "email",
        holderPrimaryId: "a",
        claimantPrimaryId: "c",
      })
      expect(String((refused as Error).message)).toBe(
        `[Sixb] Another '${Person.id}' object already has this 'email'.`
      )

      expect(await person(storage, "a")).toMatchObject({ properties: { email: "ada@example.com" } })
      expect(await person(storage, "c")).toBeNull()
    })
  })

  test(`${name} lets any number of objects hold null or no value`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([create("a", { email: null }), create("b", {}), create("c", {})])
      await edits.commit([create("d", { email: null })])
      expect(await person(storage, "d")).not.toBeNull()
    })
  })

  // Removal proof: in PostgreSQL's `applyStaged`, claim unique values before releasing them; this
  // swap and the publication's below then fail.
  test(`${name} moves values between objects within one commit`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([
        create("a", { email: "1@example.com" }),
        create("b", { email: "2@example.com" }),
        create("c", { email: "3@example.com" }),
      ])

      await edits.commit([setEmail("a", "2@example.com"), setEmail("b", "1@example.com")])
      await edits.commit([
        setEmail("a", "3@example.com"),
        setEmail("b", "2@example.com"),
        setEmail("c", "1@example.com"),
      ])

      expect(await emails(storage, ["a", "b", "c"])).toEqual([
        "3@example.com",
        "2@example.com",
        "1@example.com",
      ])
      await expect(edits.commit([create("d", { email: "3@example.com" })])).rejects.toBeInstanceOf(
        UniqueValueViolationError
      )
    })
  })

  test(`${name} frees a value that an update, a delete or an unset gives up`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([
        create("a", { email: "1@example.com" }),
        create("b", { email: "2@example.com" }),
        create("c", { email: "3@example.com" }),
      ])

      await edits.commit([setEmail("a", "4@example.com")])
      await edits.commit([{ id: "delete", kind: "object.delete", ref: personRef("b") }])
      await edits.commit([
        {
          id: "unset",
          kind: "object.patch",
          ref: personRef("c"),
          set: {},
          unset: ["email"],
          reset: [],
        },
      ])

      await edits.commit([
        create("d", { email: "1@example.com" }),
        create("e", { email: "2@example.com" }),
        create("f", { email: "3@example.com" }),
      ])
      expect(await emails(storage, ["d", "e", "f"])).toEqual([
        "1@example.com",
        "2@example.com",
        "3@example.com",
      ])
    })
  })

  test(`${name} refuses a restore that takes back a value given away`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await publish(storage, 1, [entry("p", "p@example.com")])
      await edits.commit([{ id: "delete", kind: "object.delete", ref: personRef("p") }])
      await edits.commit([create("a", { email: "p@example.com" })])

      await expect(
        edits.commit([{ id: "restore", kind: "object.restore", ref: personRef("p") }])
      ).rejects.toBeInstanceOf(UniqueValueViolationError)
      expect(await person(storage, "p")).toBeNull()
    })
  })

  test(`${name} refuses two objects claiming one value in the same commit`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await expect(
        edits.commit([
          create("a", { email: "x@example.com" }),
          create("b", { email: "x@example.com" }),
        ])
      ).rejects.toBeInstanceOf(UniqueValueViolationError)
      expect(await person(storage, "a")).toBeNull()
    })
  })

  test(`${name} compares values exactly and keys user references by id`, async () => {
    await withStorage(async (storage) => {
      await createUsers(storage, ["usr_1", "usr_2"])
      const edits = editor(storage)
      await edits.commit([
        create("a", { email: "Ada@example.com", user: { type: "user", id: "usr_1" } }),
        create("b", { email: "ada@example.com", user: { type: "user", id: "usr_2" } }),
      ])

      await expect(
        edits.commit([create("c", { user: { id: "usr_1", type: "user" } })])
      ).rejects.toMatchObject({ propertyId: "user", holderPrimaryId: "a" })
    })
  })

  test(`${name} keeps the values of each concrete type apart`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([
        create("a", { email: "same@example.com" }),
        {
          id: "employee",
          kind: "object.create",
          ref: { objectTypeId: Employee.id, primaryId: "a" },
          properties: { id: "a", email: "same@example.com" },
        },
      ])

      await expect(
        edits.commit([
          {
            id: "employee",
            kind: "object.create",
            ref: { objectTypeId: Employee.id, primaryId: "b" },
            properties: { id: "b", email: "same@example.com" },
          },
        ])
      ).rejects.toMatchObject({ objectTypeId: Employee.id, holderPrimaryId: "a" })
    })
  })

  const waitForLockWait = provider.waitForLockWait
  if (waitForLockWait) {
    // The second commit reads before the first one commits; storage still lets one value win.
    test(`${name} gives a value to one of two concurrent commits`, async () => {
      await withStorage(async (storage) => {
        const paused = pauseBeforeFinalize(storage)
        const first = editor(paused.storage).commit([create("a", { email: "race@example.com" })])
        await paused.reached

        const second = editor(storage)
          .commit([create("b", { email: "race@example.com" })])
          .catch((error: unknown) => error)
        await waitForLockWait(storage, second)
        paused.release()

        await expect(first).resolves.toMatchObject({ created: true })
        expect(await second).toBeInstanceOf(UniqueValueViolationError)
        expect(await person(storage, "b")).toBeNull()
      })
    })
  }

  test(`${name} fails a publication whose objects share a value and keeps the previous one`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("p-1", "1@example.com"), entry("p-2", "2@example.com")])

      const refused = await publish(storage, 2, [
        entry("p-1", "same@example.com"),
        entry("p-2", "same@example.com"),
      ]).catch((error: unknown) => error)

      expect(refused).toBeInstanceOf(UniqueValueViolationError)
      expect(refused).toMatchObject({ holderPrimaryId: "p-1", claimantPrimaryId: "p-2" })
      expect(await emails(storage, ["p-1", "p-2"])).toEqual(["1@example.com", "2@example.com"])
    })
  })

  test(`${name} fails a publication that takes a value an edit gave to another object`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await publish(storage, 1, [entry("p-1", "1@example.com")])
      await edits.commit([create("edited", { email: "taken@example.com" })])
      await edits.commit([setEmail("p-1", "override@example.com")])

      await expect(
        publish(storage, 2, [entry("p-1", "1@example.com"), entry("p-2", "taken@example.com")])
      ).rejects.toMatchObject({ holderPrimaryId: "edited", claimantPrimaryId: "p-2" })

      // The edit overrides what p-1's source says, and keeps its value against p-3.
      await expect(
        publish(storage, 3, [entry("p-1", "1@example.com"), entry("p-3", "override@example.com")])
      ).rejects.toMatchObject({ holderPrimaryId: "p-1", claimantPrimaryId: "p-3" })

      // The value p-1's source still asserts is free, since the edit gave it up.
      await publish(storage, 4, [entry("p-1", "1@example.com"), entry("p-3", "1@example.com")])
      expect(await emails(storage, ["p-1", "p-3"])).toEqual([
        "override@example.com",
        "1@example.com",
      ])
    })
  })

  // Planned one row at a time: each object's release and claim are staged apart from the other's.
  test(`${name} swaps values in a publication planned one row at a time`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("p-1", "1@example.com"), entry("p-2", "2@example.com")])
      await publish(storage, 2, [entry("p-1", "2@example.com"), entry("p-2", "1@example.com")])
      expect(await emails(storage, ["p-1", "p-2"])).toEqual(["2@example.com", "1@example.com"])
    })
  })

  test(`${name} keys integers beyond 2^53 too`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([create("a", { badge: 2 ** 60 })])

      await expect(edits.commit([create("b", { badge: 2 ** 60 })])).rejects.toMatchObject({
        propertyId: "badge",
        holderPrimaryId: "a",
      })
    })
  })

  if (!provider.preparesOnClaim) {
    // Removal proof: skip the prepared check of the provider's claim; the write then succeeds
    // over values nobody built.
    test(`${name} refuses a claim on a property no preparation built`, async () => {
      await withStorage(
        async (storage) => {
          await expect(
            editor(storage).commit([create("a", { email: "a@example.com" })])
          ).rejects.toThrow(
            `[Sixb] Unique property '${Person.id}.email' is not prepared. Run \`sixb db migrate\`.`
          )
        },
        { prepared: false }
      )
    })
  }

  test(`${name} prepares a property again when its keys change kind`, async () => {
    await withStorage(async (storage) => {
      const kindOf = async () =>
        (await storage.ontology.uniqueValues.listPrepared({ projectId: PROJECT })).find(
          (prepared) => prepared.objectTypeId === Person.id && prepared.propertyId === "badge"
        )?.keyKind
      expect(await kindOf()).toBe("integer")

      const Badge = defineValueType({ id: "Badge", name: "Badge", schema: "userRef" })
      const userBadges = new OntologyRegistry({
        sources: [
          defineObjectType({
            id: Person.id,
            name: "Person",
            properties: [
              prop("id", "string", { primary: true, required: true }),
              prop("badge", valueTypeRef(Badge), { unique: true }),
            ],
          }),
        ],
      })
      await migrateStorage(storage, { projectId: PROJECT, ontology: userBadges })
      expect(await kindOf()).toBe("userRef")
    })
  })

  test(`${name} prepares a property that becomes unique over existing objects`, async () => {
    await withStorage(async (storage) => {
      // Not unique yet: no values are kept for it.
      await migrateStorage(storage, { projectId: PROJECT, ontology: plainOntology })
      const plain = editor(storage, plainOntology)
      await plain.commit([
        create("a", { email: "a@example.com" }),
        create("b", { email: "b@example.com" }),
        create("c", {}),
      ])

      await migrateStorage(storage, { projectId: PROJECT, ontology })
      await expect(
        editor(storage).commit([create("d", { email: "a@example.com" })])
      ).rejects.toMatchObject({ holderPrimaryId: "a", claimantPrimaryId: "d" })

      // No longer unique: its values are dropped, and duplicates are allowed again.
      await migrateStorage(storage, { projectId: PROJECT, ontology: plainOntology })
      await plain.commit([create("d", { email: "a@example.com" })])

      // Unique again, over objects that now share a value.
      await expect(migrateStorage(storage, { projectId: PROJECT, ontology })).rejects.toThrow(
        `[Sixb] Cannot make '${Person.id}.email' unique: objects 'a' and 'd' share a value. Fix the data, then start again.`
      )
      await plain.commit([setEmail("d", "d@example.com")])
      await migrateStorage(storage, { projectId: PROJECT, ontology })
      await expect(
        editor(storage).commit([create("e", { email: "d@example.com" })])
      ).rejects.toMatchObject({ holderPrimaryId: "d" })
    })
  })
}

function editor(storage: Storage, registry: OntologyRegistry = ontology) {
  const registryProjections =
    registry === ontology
      ? projections
      : new ProjectionRegistry({ projections: [], ontology: registry, datasetsById: new Map() })
  const materializer = createMaterializer(storage, registry, registryProjections).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "unique-values-contract-execution",
      requestId: "unique-values-contract-request",
      correlationId: "unique-values-contract-correlation",
    })
  )
  let ordinal = 0
  return {
    commit(operations: readonly OntologyEditOperation[]) {
      ordinal += 1
      return materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: `unique-edit-${crypto.randomUUID()}-${ordinal}` },
        operations,
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
  }
}

function createMaterializer(
  storage: Storage,
  registry: OntologyRegistry = ontology,
  registryProjections: ProjectionRegistry = projections
): OntologyMaterializer {
  return createOntologyMaterializer({
    projectId: PROJECT,
    ontology: registry,
    projections: registryProjections,
    storage,
    dependencies: { batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 } },
  })
}

function personRef(primaryId: string) {
  return { objectTypeId: Person.id, primaryId }
}

function create(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): OntologyEditOperation {
  return {
    id: `create-${primaryId}`,
    kind: "object.create",
    ref: personRef(primaryId),
    properties: { id: primaryId, ...properties },
  }
}

function setEmail(primaryId: string, email: string): OntologyEditOperation {
  return {
    id: `email-${primaryId}`,
    kind: "object.patch",
    ref: personRef(primaryId),
    set: { email },
    unset: [],
    reset: [],
  }
}

function person(storage: Storage, primaryId: string) {
  return storage.objects.getByPrimaryId({ projectId: PROJECT, ...personRef(primaryId) })
}

async function emails(storage: Storage, primaryIds: readonly string[]) {
  const rows = await Promise.all(primaryIds.map((primaryId) => person(storage, primaryId)))
  return rows.map((row) => row?.properties.email)
}

async function createUsers(storage: Storage, ids: readonly string[]): Promise<void> {
  const users = storage.auth?.users
  if (!users) throw new Error("[Sixb] Unique values contract requires auth user storage.")
  for (const id of ids) await users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
}

function entry(primaryId: string, email: string): ProjectionSourceEntry {
  const ref = personRef(primaryId)
  return {
    root: { kind: "object", ref },
    assertions: [{ kind: "object", ref, properties: { email, name: primaryId } }],
  }
}

async function publish(
  storage: Storage,
  version: number,
  values: readonly ProjectionSourceEntry[]
) {
  const datasetVersion = {
    datasetId: people.id,
    versionId: `people-v${version}`,
    createdAt: `2026-03-${String(version).padStart(2, "0")}T00:00:00.000Z`,
  }
  const resolved = projections.resolveSource(peopleProjection.id)
  const runId = `people-run-${version}`
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: peopleProjection.id,
      datasetVersion,
      ontologyRevision: projections.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: Person.id },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`Test execution for '${runId}' is missing.`)
  const bound = createMaterializer(storage).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: peopleProjection.id, runId },
    })
  )

  return bound.projections.replace({
    source: { projectionId: peopleProjection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield* values
    })(),
  })
}

/** The same storage, whose transactions wait before they finalize until released. */
function pauseBeforeFinalize(storage: Storage) {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const paused = new Proxy(storage, {
    get(target, property) {
      if (property !== "transaction") {
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return (run: (tx: Storage) => unknown, options?: Parameters<Storage["transaction"]>[1]) =>
        target.transaction((tx) => {
          const materializations = new Proxy(tx.ontology.materializations, {
            get(store, key) {
              const value = Reflect.get(store, key, store)
              if (key !== "finalize") return typeof value === "function" ? value.bind(store) : value
              return async (...args: Parameters<typeof store.finalize>) => {
                reached.resolve()
                await released.promise
                return store.finalize(...args)
              }
            },
          })
          const ontologyStorage = new Proxy(tx.ontology, {
            get: (store, key) =>
              key === "materializations" ? materializations : Reflect.get(store, key, store),
          })
          return run(
            new Proxy(tx, {
              get: (store, key) =>
                key === "ontology" ? ontologyStorage : Reflect.get(store, key, store),
            })
          )
        }, options)
    },
  })
  return { storage: paused, reached: reached.promise, release: () => released.resolve() }
}
