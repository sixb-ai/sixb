import { expect } from "bun:test"
import {
  defineObjectType,
  type EmbeddingModel,
  OntologyRegistry,
  prop,
} from "../../packages/core/src"
import { MaterializationConflictError } from "../../packages/core/src/materialization/errors"
import type { Storage } from "../../packages/core/src/storage"
import { createMaterializerTestFixture, createTestSixb } from "../../packages/core/src/testing"
import { createTestRuntimeDeps } from "../../packages/core/tests/test-runtime-deps"

export async function assertVectorBatchInvalidation(storage: Storage): Promise<void> {
  const model: EmbeddingModel = {
    providerId: "test",
    modelId: "embedding",
    definition: { kind: "embedding", providerId: "test", modelId: "embedding", dimensions: 2 },
    async embed({ texts }) {
      return { vectors: texts.map(() => [1, 0]) }
    },
  }
  const Product = defineObjectType({
    id: "BatchProduct",
    name: "Product",
    properties: [prop("id", "string", { primary: true, required: true }), prop("text", "string")],
    search: { vectors: { content: { source: ["text"], model } } },
  })
  const projectId = "invalidate-batch"
  const sixb = createTestSixb({
    id: projectId,
    ontology: [Product],
    models: { embedding: [model] },
    ...createTestRuntimeDeps(),
    storage,
  })
  const fixture = createMaterializerTestFixture({
    projectId,
    storage,
    ontology: new OntologyRegistry({ sources: [Product] }),
  })
  const refs = ["a", "b"].map((primaryId) => ({ objectTypeId: Product.id, primaryId }))
  await fixture.seed({
    objects: refs.map((ref) => ({ ref, properties: { id: ref.primaryId, text: "before" } })),
  })
  for (const ref of refs) await sixb.objects(Product).byId(ref.primaryId).vector("content").index()
  const vectors = storage.ontology.vectors!
  const before = await vectors.listBatch({ projectId, refs })
  expect(before).toHaveLength(2)
  expect(await vectors.listBatch({ projectId: "other", refs })).toEqual([])
  expect(await vectors.listBatch({ projectId, refs: [...refs, ...refs] })).toEqual(before)
  const commit = await storage.ontology.commits.getById({ projectId, id: before[0]!.lastCommitId })
  // Removal proof: drop removeBatch's revision predicate; the stale removal incorrectly succeeds.
  await expect(
    storage.transaction(async (tx) => {
      const session = await tx.ontology.materializations.begin({
        commit: {
          ...commit!,
          id: "stale-removal",
          idempotencyKey: "stale-removal",
          requestHash: "stale-removal",
        },
        expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
      })
      await tx.ontology.vectors!.removeBatch({
        projectId,
        session,
        entries: before.map((entry, i) => ({
          ref: entry.ref,
          profile: entry.profile,
          expectedCommitId: i === 0 ? entry.lastCommitId : "stale",
        })),
      })
    })
  ).rejects.toBeInstanceOf(MaterializationConflictError)
  expect(await vectors.listBatch({ projectId, refs })).toEqual(before)
  await fixture.seed({
    objects: refs.map((ref) => ({ ref, properties: { id: ref.primaryId, text: "after" } })),
  })
  expect(await vectors.listBatch({ projectId, refs })).toEqual([])
}
