import {
  defineObjectType,
  type EmbeddingModel,
  link,
  type ObjectVectorHandle,
  prop,
  type RerankingModel,
} from "../src"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

declare const model: EmbeddingModel
declare const relevance: RerankingModel
const Product = defineObjectType({
  id: "VectorProduct",
  name: "Product",
  properties: [prop("id", "string", { primary: true }), prop("title", "string")],
  search: { vectors: { content: { source: ["title"], model } } },
})
const Collection = defineObjectType({
  id: "VectorCollection",
  name: "Collection",
  properties: [prop("id", "string", { primary: true })],
  links: [link("products", Product)],
})
const sixb = createTestSixb({
  ontology: [Product, Collection],
  models: { embedding: [model] },
  ...createTestRuntimeDeps(),
})
const profile: ObjectVectorHandle = sixb.objects(Product).byId("one").vector("content")
sixb.objects(Product).query().vector("content", "search", { k: 1 })
sixb
  .objects(Product)
  .query()
  .vector("content", "search", { k: 50 })
  .rerank({ model: relevance })
  .limit(10)
// @ts-expect-error an embedding model cannot serve as a reranker
sixb.objects(Product).query().vector("content", "search", { k: 50 }).rerank({ model })
const linkedProducts = sixb.objects(Collection).query().traverse(Collection.l.products)
linkedProducts.vector("content", "search", { k: 1 })
// @ts-expect-error an outgoing direct target retains its known profiles
linkedProducts.vector("missing", "search", { k: 1 })
// @ts-expect-error a concrete type with no vector profiles still rejects all names
sixb.objects(Collection).query().vector("content", "search", { k: 1 })
// Without a generated registry, an incoming target uses the loose type; names resolve at runtime.
sixb
  .objects(Product)
  .query()
  .traverse(Collection.l.products, { direction: "incoming" })
  .vector("runtime-profile", "search", { k: 1 })
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
