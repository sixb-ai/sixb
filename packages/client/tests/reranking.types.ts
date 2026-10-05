import type { ObjectQuery } from "../src/generated/types.gen"

// Removal proof: omit the rerank variant from ObjectQueryOpenApiSchemas, regenerate the client,
// and run typecheck:tests. The HTTP validator alone must not satisfy this contract.
const query: ObjectQuery = {
  kind: "rerank",
  model: { provider: "vercel-ai-gateway", modelId: "voyage/rerank-2.5-lite" },
  input: {
    kind: "vector",
    input: { kind: "start", objectTypeId: "Product" },
    profile: "content",
    vector: "lightweight running shoes",
    k: 50,
  },
}
void query
