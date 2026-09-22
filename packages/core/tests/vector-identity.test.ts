import { expect, test } from "bun:test"
import { defineObjectType, type EmbeddingModel, OntologyRegistry, prop } from "../src"
import { assertEmbeddingModel, sameEmbeddingModel } from "../src/models/embedding-model"
import { vectorConfiguration } from "../src/objects/vectors/profile"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function binding(name = "small", version = "1"): EmbeddingModel {
  return {
    providerId: "test",
    modelId: "deployment",
    definition: {
      kind: "embedding",
      providerId: "test",
      modelId: "deployment",
      dimensions: 2,
      representation: { name, version },
    },
    async embed({ texts }) {
      return { vectors: texts.map(() => [1, 0]) }
    },
  }
}
function product(model: EmbeddingModel) {
  return defineObjectType({
    id: "Product",
    name: "Product",
    properties: [prop("id", "string", { primary: true, required: true }), prop("text", "string")],
    search: { vectors: { content: { source: ["text"], model } } },
  })
}

test("representation changes exclude stored vectors even when the route and dimensions are unchanged", async () => {
  // Removal proof: omit representation from vectorConfiguration; the old vector is returned.
  const deps = createTestRuntimeDeps()
  const original = binding()
  const Product = product(original)
  const objects = createTestSixb({
    id: "identity",
    ontology: [Product],
    models: { embedding: [original] },
    ...deps,
  }).objects(Product)
  await objects.upsert({ properties: { id: "a", text: "source" } })
  await objects.byId("a").vector("content").index()
  for (const changed of [binding("large"), binding("small", "2")]) {
    const Changed = product(changed)
    const next = createTestSixb({
      id: "identity",
      ontology: [Changed],
      models: { embedding: [changed] },
      ...deps,
    }).objects(Changed)
    expect((await next.query().vector("content", [1, 0], { k: 1 }).list()).objects).toEqual([])
    expect(sameEmbeddingModel(original, changed)).toBe(false)
    expect(() => {
      createTestSixb({ ontology: [Product], models: { embedding: [changed] }, ...deps })
    }).toThrow("matching identity")
  }
})

test("profile snapshots detach representation and explicit direct-model identity is equivalent", () => {
  const model = binding()
  const type = product(model)
  const snapshot = new OntologyRegistry({ sources: [type] }).resolveObjectType(type.id).search!
    .vectors!.content!
  expect(snapshot.model.definition.representation).toEqual({ name: "small", version: "1" })
  expect(snapshot.model.definition.representation).not.toBe(model.definition.representation)
  expect(Object.isFrozen(snapshot.model.definition.representation)).toBe(true)
  const direct = { ...model, definition: { ...model.definition, representation: undefined } }
  const explicit = {
    ...direct,
    definition: { ...direct.definition, representation: { name: direct.modelId } },
  }
  expect(sameEmbeddingModel(direct, explicit)).toBe(true)
  expect(vectorConfiguration({ source: ["text"], model: direct })).toBe(
    vectorConfiguration({ source: ["text"], model: explicit })
  )
  for (const representation of [{ name: " " }, { name: "small", version: "" }]) {
    expect(() =>
      assertEmbeddingModel({ ...model, definition: { ...model.definition, representation } })
    ).toThrow("representation")
  }
})
