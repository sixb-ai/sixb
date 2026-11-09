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
import {
  createOntologyMaterializer,
  type OntologyEditOperation,
  ProjectionRegistry,
  type ProjectionSourceEntry,
} from "../materializer"
import type { ArtifactHolder } from "../storage/ontology"
import { startTestProjectionRun } from "./projection-execution"
import { createStoredArtifact } from "./stored-artifacts"

export interface ArtifactHoldersContractProvider<TStorage extends Storage> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const PROJECT = "artifact-holders-contract"

const KICKOFF = "art_kkkkkkkkkk"
const AGENDA = "art_aaaaaaaaaa"
const NOTES = "art_nnnnnnnnnn"

const Section = defineValueType({
  id: "ArtifactHoldersContractSection",
  name: "Section",
  schema: { type: "object", properties: { doc: { schema: ref.artifact() } } },
})

const Meeting = defineObjectType({
  id: "ArtifactHoldersContractMeeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("kickoffDoc", ref.artifact(), { nullable: true }),
    prop("attachments", { type: "array", items: ref.artifact() }),
    prop("sections", { type: "map", keySchema: "string", valueSchema: valueTypeRef(Section) }),
  ],
})

const meetings = defineDataset("artifact_holders_contract_meetings", {
  schema: [col("id", "string"), col("title", "string")],
})

const meetingsProjection = defineProjection("artifact_holders_contract_meetings", Meeting)
  .fromDataset(meetings)
  .properties({ id: "id", title: "title" })

const ontology = new OntologyRegistry({ sources: [Meeting] })

const projections = new ProjectionRegistry({
  projections: [meetingsProjection],
  ontology,
  datasetsById: new Map<string, DatasetDefinition>([[meetings.id, meetings]]),
})

/**
 * The index of the objects that hold each artifact, on a storage provider: every object write
 * keeps it in its own transaction, whichever ingress wrote, so it always says which object
 * properties hold an artifact now.
 *
 * Removal proof: drop `appendArtifactHolderWork` from `materializer/edits/plan.ts`, or a
 * provider's insert or delete of the rows it plans, and these tests fail.
 */
export function runArtifactHoldersContractSuite<TStorage extends Storage>(
  name: string,
  provider: ArtifactHoldersContractProvider<TStorage>
): void {
  async function withStorage(run: (storage: TStorage) => Promise<void>): Promise<void> {
    const storage = await provider.createStorage()
    try {
      for (const id of [KICKOFF, AGENDA, NOTES]) {
        await createStoredArtifact(storage, { projectId: PROJECT, id })
      }

      await run(storage)
    } finally {
      await provider.cleanup?.(storage)
    }
  }

  test(`${name} records each property that holds an artifact, wherever it sits in the value`, async () => {
    await withStorage(async (storage) => {
      await editor(storage).commit([
        create("m-1", {
          kickoffDoc: artifact(KICKOFF),
          attachments: [artifact(KICKOFF), artifact(AGENDA), artifact(KICKOFF)],
          sections: { intro: { doc: artifact(NOTES) } },
        }),
      ])

      expect(await holders(storage, KICKOFF)).toEqual([
        holder("m-1", "attachments"),
        holder("m-1", "kickoffDoc"),
      ])
      expect(await holders(storage, AGENDA)).toEqual([holder("m-1", "attachments")])
      expect(await holders(storage, NOTES)).toEqual([holder("m-1", "sections")])
    })
  })

  test(`${name} follows patches and upserts: what a write gives up leaves, what it takes arrives`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([
        create("m-1", { kickoffDoc: artifact(KICKOFF), attachments: [artifact(AGENDA)] }),
      ])

      await edits.commit([patch("m-1", { kickoffDoc: artifact(AGENDA) }, ["attachments"])])
      expect(await holders(storage, KICKOFF)).toEqual([])
      expect(await holders(storage, AGENDA)).toEqual([holder("m-1", "kickoffDoc")])

      await edits.commit([upsert("m-1", { title: "Kick-off", kickoffDoc: null })])
      expect(await holders(storage, AGENDA)).toEqual([])

      await edits.commit([upsert("m-1", { attachments: [artifact(NOTES)] })])
      expect(await holders(storage, NOTES)).toEqual([holder("m-1", "attachments")])
    })
  })

  test(`${name} drops every artifact of a deleted object`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)
      await edits.commit([
        create("m-1", { kickoffDoc: artifact(KICKOFF), attachments: [artifact(AGENDA)] }),
        create("m-2", { kickoffDoc: artifact(KICKOFF) }),
      ])

      await edits.commit([remove("m-1")])

      expect(await holders(storage, KICKOFF)).toEqual([holder("m-2", "kickoffDoc")])
      expect(await holders(storage, AGENDA)).toEqual([])
    })
  })

  test(`${name} keeps nothing of a write that fails`, async () => {
    await withStorage(async (storage) => {
      const edits = editor(storage)

      // An atomic commit fails whole: its first object never held anything.
      await expect(
        edits.commit([
          create("m-1", { kickoffDoc: artifact(KICKOFF) }),
          create("m-2", { title: 42 }),
        ])
      ).rejects.toThrow("must be a string")
      expect(await holders(storage, KICKOFF)).toEqual([])

      // A continue-mode item fails alone.
      const result = await edits.commitEach([
        create("m-3", { kickoffDoc: artifact(KICKOFF) }),
        create("m-4", { title: 42, kickoffDoc: artifact(KICKOFF) }),
      ])
      expect(result.outcomes.map((outcome) => outcome.ok)).toEqual([true, false])
      expect(await holders(storage, KICKOFF)).toEqual([holder("m-3", "kickoffDoc")])
    })
  })

  // Removal proof: drop `appendArtifactHolderWork` from
  // `materializer/projections/replacement-plan.ts`.
  test(`${name} drops a projected object's artifacts when a publication removes it, and takes them back when it returns`, async () => {
    await withStorage(async (storage) => {
      await publish(storage, 1, [entry("m-p", "Kick-off")])
      await editor(storage).commit([patch("m-p", { kickoffDoc: artifact(KICKOFF) })])
      expect(await holders(storage, KICKOFF)).toEqual([holder("m-p", "kickoffDoc")])

      await publish(storage, 2, [])
      expect(await holders(storage, KICKOFF)).toEqual([])

      // The edit outlived the row it patched: the object comes back holding the artifact.
      await publish(storage, 3, [entry("m-p", "Kick-off")])
      expect(await holders(storage, KICKOFF)).toEqual([holder("m-p", "kickoffDoc")])
    })
  })

  test(`${name} lists holders a page at a time, by code point, and per project`, async () => {
    await withStorage(async (storage) => {
      // By code point: "B" (U+0042) < "a" (U+0061) < "b" < "é" (U+00E9).
      await editor(storage).commit(
        ["é", "b", "B", "a"].map((primaryId) =>
          create(primaryId, { kickoffDoc: artifact(KICKOFF), attachments: [artifact(KICKOFF)] })
        )
      )

      const pages: ArtifactHolder[][] = []
      let after: ArtifactHolder | undefined
      do {
        const page = await storage.objects.listArtifactHolders({
          projectId: PROJECT,
          artifactId: KICKOFF,
          limit: 3,
          ...(after ? { after } : {}),
        })
        pages.push([...page.holders])
        after = page.next
      } while (after)

      expect(pages).toEqual([
        [holder("B", "attachments"), holder("B", "kickoffDoc"), holder("a", "attachments")],
        [holder("a", "kickoffDoc"), holder("b", "attachments"), holder("b", "kickoffDoc")],
        [holder("é", "attachments"), holder("é", "kickoffDoc")],
      ])

      const elsewhere = await storage.objects.listArtifactHolders({
        projectId: "another-project",
        artifactId: KICKOFF,
        limit: 10,
      })
      expect(elsewhere).toEqual({ holders: [] })
    })
  })
}

function editor(storage: Storage) {
  const materializer = createMaterializer(storage).withScope(
    createTestingScope({
      projectId: PROJECT,
      executionId: "artifact-holders-contract-execution",
      requestId: "artifact-holders-contract-request",
      correlationId: "artifact-holders-contract-correlation",
    })
  )
  const requestId = () => `artifact-holders-edit-${crypto.randomUUID()}`

  return {
    commit(operations: readonly OntologyEditOperation[]) {
      return materializer.edits.commit({
        mode: "atomic",
        source: { kind: "runtime", requestId: requestId() },
        operations,
        expectedObjects: [],
        expectedLinks: [],
        expectedLinkScopes: [],
      })
    },
    /** Applies each operation alone, keeping those that succeed. */
    commitEach(operations: readonly OntologyEditOperation[]) {
      return materializer.edits.commit({
        mode: "continue",
        source: { kind: "runtime", requestId: requestId() },
        operations,
      })
    },
  }
}

function createMaterializer(storage: Storage) {
  return createOntologyMaterializer({
    projectId: PROJECT,
    ontology,
    projections,
    storage,
    dependencies: { batching: { sourceStageRows: 1, statePageRows: 1, planChunkRows: 1 } },
  })
}

function artifact(id: string): JsonValue {
  return { type: "artifact", id }
}

function holder(primaryId: string, propertyId: string): ArtifactHolder {
  return { objectTypeId: Meeting.id, primaryId, propertyId }
}

async function holders(storage: Storage, artifactId: string): Promise<ArtifactHolder[]> {
  const page = await storage.objects.listArtifactHolders({
    projectId: PROJECT,
    artifactId,
    limit: 100,
  })
  return [...page.holders]
}

function meetingRef(primaryId: string) {
  return { objectTypeId: Meeting.id, primaryId }
}

function create(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): OntologyEditOperation {
  return {
    id: `create-${primaryId}`,
    kind: "object.create",
    ref: meetingRef(primaryId),
    properties: { id: primaryId, ...properties },
  }
}

function upsert(
  primaryId: string,
  properties: Readonly<Record<string, JsonValue>>
): OntologyEditOperation {
  return {
    id: `upsert-${primaryId}`,
    kind: "object.upsert",
    ref: meetingRef(primaryId),
    properties: { id: primaryId, ...properties },
  }
}

function patch(
  primaryId: string,
  set: Readonly<Record<string, JsonValue>>,
  unset: readonly string[] = []
): OntologyEditOperation {
  return {
    id: `patch-${primaryId}`,
    kind: "object.patch",
    ref: meetingRef(primaryId),
    set,
    unset,
    reset: [],
  }
}

function remove(primaryId: string): OntologyEditOperation {
  return { id: `delete-${primaryId}`, kind: "object.delete", ref: meetingRef(primaryId) }
}

function entry(primaryId: string, title: string): ProjectionSourceEntry {
  const ref = meetingRef(primaryId)
  return {
    root: { kind: "object", ref },
    assertions: [{ kind: "object", ref, properties: { title } }],
  }
}

async function publish(
  storage: Storage,
  version: number,
  values: readonly ProjectionSourceEntry[]
) {
  const datasetVersion = {
    datasetId: meetings.id,
    versionId: `meetings-v${version}`,
    createdAt: `2026-11-${String(version).padStart(2, "0")}T00:00:00.000Z`,
  }
  const resolved = projections.resolveSource(meetingsProjection.id)
  const runId = `meetings-run-${version}`
  const { execution } = await startTestProjectionRun(storage, {
    id: runId,
    projectId: PROJECT,
    identity: {
      projectionId: meetingsProjection.id,
      datasetVersion,
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
      projectionKind: "object",
      protocol: "replacement",
    },
    target: { objectTypeId: Meeting.id },
  })

  const stored = await storage.executions.getById({
    projectId: PROJECT,
    id: `test_projection_execution:${runId}`,
  })
  if (!stored) throw new Error(`Test execution for '${runId}' is missing.`)

  const bound = createMaterializer(storage).withScope(
    restoreTrustedPrimitiveExecutionScope({
      execution: stored,
      primitive: { kind: "projection", id: meetingsProjection.id, runId },
    })
  )

  return bound.projections.replace({
    source: { projectionId: meetingsProjection.id },
    datasetVersion,
    execution,
    entries: (async function* () {
      yield* values
    })(),
  })
}
