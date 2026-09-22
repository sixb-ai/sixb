import { expect } from "bun:test"
import {
  defineObjectType,
  type EmbeddingModel,
  OntologyRegistry,
  prop,
} from "../../packages/core/src"
import { MaterializationConflictError } from "../../packages/core/src/materialization/errors"
import type { ObjectVectorWrite } from "../../packages/core/src/materialization/vectors"
import { vectorConfiguration, vectorSources } from "../../packages/core/src/objects/vectors/profile"
import type { Storage } from "../../packages/core/src/storage"
import { createMaterializerTestFixture } from "../../packages/core/src/testing"

/** Exercise both SQL write branches and their rollback through a real materialization session. */
export async function assertVectorBatchPublication(storage: Storage): Promise<void> {
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    async embed({ texts }) {
      return { vectors: texts.map(() => [1, 0]) }
    },
  }
  const profile = { source: ["description"], model }
  const Product = defineObjectType({
    id: "BatchProduct",
    name: "Batch product",
    properties: [
      prop("id", "string", { primary: true, required: true }),
      prop("description", "string"),
    ],
    search: { vectors: { content: profile } },
  })
  const projectId = "write-batch"
  const fixture = createMaterializerTestFixture({
    projectId,
    storage,
    ontology: new OntologyRegistry({ sources: [Product] }),
  })
  const ref = (id: string) => ({ objectTypeId: Product.id, primaryId: id })
  const vectors = storage.ontology.vectors!
  const states = (id: string) => vectors.list({ projectId, ref: ref(id) })
  await fixture.seed({
    objects: ["a", "b", "c"].map((id) => ({
      ref: ref(id),
      properties: { id, description: `Source ${id}` },
    })),
  })

  async function prepare(id: string): Promise<ObjectVectorWrite> {
    const row = await storage.objects.getByPrimaryId({ projectId, ...ref(id) })
    const [state] = await states(id)
    return {
      input: {
        projectId,
        ref: ref(id),
        profile: "content",
        configuration: vectorConfiguration(profile),
        ...vectorSources(profile.source, row!.properties),
        expectedObject: {
          ref: ref(id),
          exists: true,
          version: row!.version,
          lastCommitId: row!.lastCommitId,
        },
        expectedVectorCommitId: state?.lastCommitId ?? null,
      },
      values: [1, 0],
    }
  }
  let request = 0
  const commit = (writes: readonly ObjectVectorWrite[]) =>
    fixture.materializer.edits.commit({
      mode: "atomic",
      source: { kind: "runtime", requestId: `vectors-${++request}` },
      operations: [],
      vectorWrites: writes,
      expectedObjects: writes.map((write) => write.input.expectedObject),
      expectedLinks: [],
      expectedLinkScopes: [],
    })

  await commit(await Promise.all(["a", "c"].map(prepare)))
  const beforeA = await states("a")
  const stale = await Promise.all(["a", "b", "c"].map(prepare))
  await commit([{ ...(await prepare("c")), values: [0, 1] }])
  const beforeC = await states("c")
  const intentBefore = await storage.ontology.vectorIndexing!.listDue({
    projectId,
    now: "2100-01-01T00:00:00.000Z",
    limit: 10,
  })
  expect(intentBefore).toHaveLength(1)

  // Removal proof: omit the expected revision predicate in writeBatch; the stale commit succeeds.
  await expect(commit(stale)).rejects.toBeInstanceOf(MaterializationConflictError)
  expect(await states("a")).toEqual(beforeA)
  expect(await states("b")).toEqual([])
  expect(await states("c")).toEqual(beforeC)
  expect(
    await storage.ontology.vectorIndexing!.listDue({
      projectId,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
  ).toEqual(intentBefore)

  const result = await commit(await Promise.all(["a", "b", "c"].map(prepare)))
  for (const id of ["a", "b", "c"]) {
    expect(await states(id)).toMatchObject([
      { lastCommitId: result.commitId, source: ["description"] },
    ])
  }
  expect(
    await storage.ontology.vectorIndexing!.listDue({
      projectId,
      now: "2100-01-01T00:00:00.000Z",
      limit: 10,
    })
  ).toEqual([])
}
