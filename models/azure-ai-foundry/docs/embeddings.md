# Embedding execution

`embedding.ts` implements the core `EmbeddingModel` contract. It does not own billing persistence;
Sixb's execution session reserves and records calls around the adapter.

```text
Binding (no I/O)
  → Discover project deployment with project credentials
  → Verify declared model/version; validate dimensions and pin pricing
  → POST resource /openai/v1/embeddings with resource credentials
  → Capture usage and request ID; validate model and indexed vectors
```

- The declared model name/version is copied into `definition.representation` before any I/O.
  Profile fingerprints and runtime checks use it; discovery must agree before budget admission.
  Discovery retains its configured cache lifetime. Response identity is checked against the pin,
  but a response containing only a deployment alias cannot prove a hidden provider revision.
- `resolve()` returns an immutable execution snapshot. Direct `embed()` pins its first successful
  resolution; catalog refresh affects future resolutions, not existing snapshots.
- The catalog separates embedding entries before building language definitions. models.dev can
  label embedding output as text; known embedding families and IDs take precedence.
- Resource transport reuses authentication, redaction, HTTP errors, and redirect protection.
  Embeddings consume bounded JSON responses, not SSE, and never retry inference automatically.
- `dimensions` is sent only for third-generation OpenAI embeddings. Ada's fixed output size is
  checked locally. Response indices restore batch order; missing, duplicate, nonfinite, zero,
  or incorrectly sized vectors raise `EmbeddingModelResponseError` with available billing evidence.
- Input usage is `prompt_tokens`; a conflicting `total_tokens` leaves it unknown. Output tokens
  are zero. Unexpected usage meters disable reference pricing. Azure prices are local estimates,
  not reported invoice charges; callers may supply a deployment-specific estimator.
- Credentials and signals are isolated between project discovery and resource inference.
  Discovery has its own bounded, shared cache; cancelling one inference waiter does not abort
  discovery needed by other callers.

Foundry project endpoints do not route embeddings. Explicit resource configuration avoids guessing
an endpoint or forwarding project credentials to a connected resource. The deployment must match
on both endpoints; the returned model identity is validated before vectors are accepted.

Cohere's document/query input purpose is absent from the core embedding request contract, so the
adapter rejects that family instead of selecting a purpose implicitly.

References: [Foundry endpoints](https://learn.microsoft.com/en-us/azure/foundry/how-to/develop/sdk-overview),
[embeddings REST contract](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/embeddings).
