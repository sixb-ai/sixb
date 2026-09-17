import { defineObjectType, type EmbeddingModel, type ObjectVectorHandle, prop } from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

declare const model: EmbeddingModel
const Product = defineObjectType({
  id: "VectorProduct",
  name: "Product",
  properties: [prop("id", "string", { primary: true }), prop("title", "string")],
  search: { vectors: { content: { source: ["title"], model } } },
})
const sixb = createTestSixb({
  ontology: [Product],
  models: { embedding: [model] },
  ...createTestRuntimeDeps(),
})
const profile: ObjectVectorHandle = sixb.objects(Product).byId("one").vector("content")
sixb.objects(Product).query().vector("content", "search", { k: 1 })
// @ts-expect-error profiles are inferred from this object type's definition
sixb.objects(Product).byId("one").vector("missing")
// @ts-expect-error query profiles are inferred too
sixb.objects(Product).query().vector("missing", "search", { k: 1 })
// @ts-expect-error no generated vector property in the business schema
Product.p.content
void profile

profile.index()
// @ts-expect-error preparation is internal
profile.prepare()
// @ts-expect-error raw writes are internal
profile.write({}, [1, 0])

// @ts-expect-error search accepts text only
sixb.objects(Product).query().vector("content", [1, 0], { k: 1 })
// @ts-expect-error search requires a profile, not a property
sixb.objects(Product).query().vector(Product.p.title, "search", { k: 1 })
